// Shared credential-stripping + bundle-emitting pipeline used by both the
// per-workspace `GET /:workspaceId/bundle` route and the full-instance
// `GET /bundle-all` route. Factoring this prevents the two from drifting.

import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exportBundle, type ImportResult } from "@atlas/bundle";
import type { WorkspaceConfig } from "@atlas/config";
import {
  type CredentialUsage,
  extractCredentials,
  stripCredentialRefs,
  toProviderRefs,
} from "@atlas/config/mutations";
import { UserAdapter } from "@atlas/core/agent-loader/user-adapter";
import {
  fetchLinkCredential,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
} from "@atlas/core/mcp-registry/credential-resolver";
import type { Logger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import { stringify } from "@std/yaml";
import { injectBundledAgentRefs } from "./inject-bundled-agents.ts";

export interface BuildWorkspaceBundleInput {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  config: { workspace: WorkspaceConfig };
  mode: "definition" | "migration";
  logger: Logger;
  /**
   * Optional path to this workspace's narrative memory dir
   * (`~/.friday/local/memory/<workspaceId>/`). Only honored in `mode: migration`.
   */
  memoryDir?: string;
  /**
   * Root directory holding installed user agents (layout
   * `<dir>/<id>@<version>/`). Defaults to `<atlasHome>/agents`. Override is
   * primarily for tests.
   */
  userAgentsDir?: string;
}

export interface BuildWorkspaceBundleResult {
  bundleBytes: Uint8Array;
  /** Name as embedded in the lockfile (from the portable config, may differ from the local display name). */
  name: string;
  version: string;
}

export async function buildWorkspaceBundleBytes(
  input: BuildWorkspaceBundleInput,
): Promise<BuildWorkspaceBundleResult> {
  const configWithAgentRefs = injectBundledAgentRefs(input.config.workspace);
  const credentials = extractCredentials(configWithAgentRefs);
  const legacyRefs = credentials.filter(
    (cred): cred is CredentialUsage & { credentialId: string } =>
      !cred.provider && !!cred.credentialId,
  );

  const providerMap: Record<string, string> = {};
  const unresolvedPaths: string[] = [];
  const legacyResults = await Promise.allSettled(
    legacyRefs.map(async (ref) => {
      const credential = await fetchLinkCredential(ref.credentialId, input.logger);
      return { credentialId: ref.credentialId, provider: credential.provider, path: ref.path };
    }),
  );
  for (const [i, result] of legacyResults.entries()) {
    const ref = legacyRefs[i];
    if (!ref) continue;
    if (result.status === "fulfilled") {
      providerMap[result.value.credentialId] = result.value.provider;
    } else if (
      result.reason instanceof LinkCredentialNotFoundError ||
      result.reason instanceof LinkCredentialExpiredError
    ) {
      unresolvedPaths.push(ref.path);
    } else {
      throw result.reason;
    }
  }

  let workspaceToExport = configWithAgentRefs;
  if (unresolvedPaths.length > 0) {
    workspaceToExport = stripCredentialRefs(workspaceToExport, unresolvedPaths);
  }
  const portableConfig = toProviderRefs(workspaceToExport, providerMap);
  const { id: _id, ...workspaceIdentity } = portableConfig.workspace;
  const exportConfig = { ...portableConfig, workspace: workspaceIdentity };
  const workspaceYml = stringify(exportConfig, { indent: 2, lineWidth: 100 });

  const name = portableConfig.workspace.name ?? input.workspaceName;
  const version = (portableConfig.version as string | undefined) ?? "1.0.0";

  const externalAgents = await resolveExternalUserAgents({
    config: configWithAgentRefs,
    workspacePath: input.workspacePath,
    userAgentsDir: input.userAgentsDir ?? join(getFridayHome(), "agents"),
    logger: input.logger,
  });

  const bundleBytes = await exportBundle({
    workspaceDir: input.workspacePath,
    workspaceYml,
    mode: input.mode,
    workspace: { name, version },
    ...(externalAgents.length > 0 ? { externalAgents } : {}),
    ...(input.mode === "migration" && input.memoryDir ? { memoryDir: input.memoryDir } : {}),
  });

  return { bundleBytes, name, version };
}

/**
 * For every `type: user` agent referenced by `workspace.yml`, locate its
 * installed source dir under `<userAgentsDir>/<id>@<version>/` so it can be
 * embedded in the bundle. Skipped when the workspace already ships a
 * same-named agent under `<workspacePath>/agents/<id>/` (workspace-local
 * wins). Throws if any referenced user agent can't be resolved — silently
 * partial bundles fail much later on the import side, so surface it here.
 */
async function resolveExternalUserAgents(opts: {
  config: WorkspaceConfig;
  workspacePath: string;
  userAgentsDir: string;
  logger: Logger;
}): Promise<{ name: string; sourceDir: string }[]> {
  const agents = opts.config.agents;
  if (!agents) return [];

  const userAgentIds = new Set<string>();
  for (const entry of Object.values(agents)) {
    if (entry.type === "user") userAgentIds.add(entry.agent);
  }
  if (userAgentIds.size === 0) return [];

  const adapter = new UserAdapter(opts.userAgentsDir);
  const resolved: { name: string; sourceDir: string }[] = [];
  const missing: string[] = [];
  for (const id of userAgentIds) {
    try {
      await stat(join(opts.workspacePath, "agents", id));
      continue;
    } catch {
      // Not present workspace-locally — fall through to resolve externally.
    }
    try {
      const source = await adapter.loadAgent(id);
      resolved.push({ name: id, sourceDir: source.metadata.sourceLocation });
    } catch {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Workspace references user agent(s) that could not be resolved under ${opts.userAgentsDir}: ${missing.join(", ")}`,
    );
  }
  return resolved;
}

/**
 * Workspaces without an on-disk directory (virtual/kernel workspaces whose
 * `path` is a URI like `system://system`) cannot be meaningfully bundled —
 * `exportBundle` looks for `<workspaceDir>/agents/` and would come up empty.
 */
export async function isOnDiskWorkspace(workspacePath: string): Promise<boolean> {
  try {
    const s = await stat(workspacePath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Install bundled user agents into the global `<atlasHome>/agents/<id>@<version>/`
 * location so the daemon's AgentRegistry (which only scans that one dir via
 * `UserAdapter`) can resolve them at runtime.
 *
 * `importBundle` extracts each embedded agent to `<targetDir>/<primitive.path>/`
 * (i.e. workspace-local). That location is invisible to the registry — the
 * UserAdapter constructor in `atlas-daemon.ts` is wired only to
 * `<atlasHome>/agents`. Without this step, an imported workspace.yml that
 * references a `type: user` agent will fail when the daemon tries to spawn it.
 *
 * Non-destructive: if `<atlasHome>/agents/<id>@<version>/` already exists, we
 * skip rather than clobber a same-version install the user may already depend
 * on. Per-agent errors are logged and recorded but do not abort the import —
 * one malformed metadata.json shouldn't sink the whole workspace.
 *
 * Mirrors the install pattern in `apps/atlasd/routes/agents/register.ts`:
 * stage to `*.tmp`, then atomic rename into place.
 */
export async function installImportedAgents(opts: {
  targetDir: string;
  primitives: ImportResult["primitives"];
  atlasHome: string;
  logger: Logger;
}): Promise<{
  installed: { id: string; version: string; path: string }[];
  skipped: { name: string; reason: string }[];
}> {
  const installed: { id: string; version: string; path: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const agents = opts.primitives.filter((p) => p.kind === "agent");
  if (agents.length === 0) return { installed, skipped };

  const agentsRoot = join(opts.atlasHome, "agents");
  await mkdir(agentsRoot, { recursive: true });

  for (const primitive of agents) {
    const sourceDir = join(opts.targetDir, primitive.path);
    const metadataPath = join(sourceDir, "metadata.json");

    let id: string;
    let version: string;
    try {
      const raw = await readFile(metadataPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as { id?: unknown }).id !== "string" ||
        typeof (parsed as { version?: unknown }).version !== "string"
      ) {
        skipped.push({ name: primitive.name, reason: "metadata.json missing id/version" });
        continue;
      }
      id = (parsed as { id: string }).id;
      version = (parsed as { version: string }).version;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      opts.logger.warn("Skipping imported agent with unreadable metadata", {
        name: primitive.name,
        path: metadataPath,
        error: reason,
      });
      skipped.push({ name: primitive.name, reason: `unreadable metadata.json: ${reason}` });
      continue;
    }

    const finalDir = join(agentsRoot, `${id}@${version}`);
    try {
      await stat(finalDir);
      opts.logger.info("Skipping imported agent — same version already installed", {
        name: primitive.name,
        id,
        version,
        path: finalDir,
      });
      skipped.push({ name: primitive.name, reason: `already installed at ${finalDir}` });
      continue;
    } catch {
      // Target absent — proceed with install.
    }

    const tmpDir = `${finalDir}.import-${Date.now().toString(36)}.tmp`;
    try {
      await rm(tmpDir, { recursive: true, force: true });
      await cp(sourceDir, tmpDir, { recursive: true });
      await rename(tmpDir, finalDir);
      installed.push({ id, version, path: finalDir });
      opts.logger.info("Installed imported user agent", {
        name: primitive.name,
        id,
        version,
        path: finalDir,
      });
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      const reason = error instanceof Error ? error.message : String(error);
      opts.logger.error("Failed to install imported agent", {
        name: primitive.name,
        id,
        version,
        error: reason,
      });
      skipped.push({ name: primitive.name, reason: `install failed: ${reason}` });
    }
  }

  return { installed, skipped };
}

/**
 * After a migration-mode import registers a workspace and obtains its new
 * local ID, move the imported `<workspaceDir>/memory/` tree (per-narrative
 * subdirs) to `<atlasHome>/memory/<newWorkspaceId>/narrative/<narrative>/`.
 * Non-destructive: if a target narrative subdir already exists we sideload
 * to `<atlasHome>/memory/<newWorkspaceId>.imported-<ts>/` and return a
 * warning string instead.
 */
export async function materializeImportedMemory(opts: {
  importedWorkspaceDir: string;
  atlasHome: string;
  newWorkspaceId: string;
}): Promise<{ kind: "moved" | "sideloaded" | "absent"; path?: string; reason?: string }> {
  const srcDir = join(opts.importedWorkspaceDir, "memory");
  try {
    const s = await stat(srcDir);
    if (!s.isDirectory()) return { kind: "absent" };
  } catch {
    return { kind: "absent" };
  }

  const targetRoot = join(opts.atlasHome, "memory", opts.newWorkspaceId, "narrative");
  await mkdir(dirname(targetRoot), { recursive: true });
  try {
    await stat(targetRoot);
    // Target exists — sideload instead of clobbering.
    const sideload = join(
      opts.atlasHome,
      "memory",
      `${opts.newWorkspaceId}.imported-${Date.now()}`,
    );
    await mkdir(dirname(sideload), { recursive: true });
    await rename(srcDir, sideload);
    return {
      kind: "sideloaded",
      path: sideload,
      reason: `target memory dir already exists at ${targetRoot}; imported memory saved to ${sideload} for manual merge`,
    };
  } catch {
    // Target absent — rename in place. Bundle layout is `memory/<narrative>/...`
    // (no explicit `narrative/` parent); we rename memory → .../narrative.
    await rename(srcDir, targetRoot);
    return { kind: "moved", path: targetRoot };
  }
}
