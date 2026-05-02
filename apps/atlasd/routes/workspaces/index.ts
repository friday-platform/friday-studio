import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  exportAll,
  exportGlobalSkills,
  importAll,
  importBundle,
  importGlobalSkills,
} from "@atlas/bundle";
import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import type { Registry, WorkspaceConfig } from "@atlas/config";
import { WorkspaceConfigSchema } from "@atlas/config";
import {
  applyMutation,
  type CredentialUsage,
  extractCredentials,
  stripCredentialRefs,
  toIdRefs,
  toProviderRefs,
} from "@atlas/config/mutations";
import {
  MissingEnvironmentError,
  SessionFailedError,
  UserConfigurationError,
  WorkspaceNotFoundError,
} from "@atlas/core";
import {
  type ValidationContext,
  validateWorkspaceConfig,
} from "@atlas/core/mcp-registry/config-validator";
import {
  CredentialNotFoundError,
  fetchLinkCredential,
  InvalidProviderError,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { createDefaultResolvers } from "@atlas/core/mcp-registry/resolvers";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { createLogger, logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { resolveVisibleSkills, SkillStorage } from "@atlas/skills";
import { FilesystemWorkspaceCreationAdapter } from "@atlas/storage";
import { ColorSchema, isErrnoException, stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { zValidator } from "@hono/zod-validator";
import { parse, stringify } from "@std/yaml";
import { z } from "zod";
import type { AppContext } from "../../src/factory.ts";
import { daemonFactory, KERNEL_WORKSPACE_ID } from "../../src/factory.ts";
import {
  CommunicatorKindSchema,
  deriveConnectionId,
  disconnectCommunicator,
  removeCommunicatorMutation,
  resolveTunnelUrl,
  setCommunicatorMutation,
  wireCommunicator,
} from "../../src/services/communicator-wiring.ts";
import { awaitSignalCompletion } from "../../src/signal-stream.ts";
import { getCurrentUser } from "../me/adapter.ts";
import {
  buildWorkspaceBundleBytes,
  isOnDiskWorkspace,
  materializeImportedMemory,
} from "./bundle-helpers.ts";
import { DEFAULT_WORKSPACE_MEMORY } from "./default-workspace-config.ts";
import {
  beginDraft,
  type DraftItemKind,
  deleteDraftItem,
  discardDraft,
  type MemoryItemKind,
  publishDraft,
  readDraft,
  removeLiveItem,
  upsertDraftItem,
  upsertDraftMemoryEntry,
  upsertLiveItem,
  upsertLiveMemoryEntry,
  validateDraft,
} from "./draft-helpers.ts";
import { injectBundledAgentRefs } from "./inject-bundled-agents.ts";
import { mapMutationError } from "./mutation-errors.ts";
import {
  addWorkspaceBatchSchema,
  addWorkspaceSchema,
  createWorkspaceFromConfigSchema,
  updateWorkspaceConfigSchema,
} from "./schemas.ts";

/**
 * Daemon-backed validation context for `validateWorkspaceConfig`.
 *
 * Skill existence is checked via `SkillStorage.get` (Result-typed; treat any
 * failure as "exists" so a broken skill DB reader doesn't block import).
 * Workspace existence is checked via the workspace manager.
 *
 * Model catalog is intentionally permissive in v1. The real catalog fetch
 * is async and expensive (~3s for a cross-provider sweep) — validating
 * every agent's model on every workspace import would add unacceptable
 * latency to what's otherwise a fast path. `createPlatformModels` validates
 * model IDs when the daemon loads friday.yml, and invalid models fail at
 * first inference, so this is a deferred check rather than a missing one.
 */
/**
 * Network-backed resolvers are disabled in test runs. Tests supply fixture
 * package names that aren't real npm packages (e.g. `some-server`), and
 * hitting the real registry would flake on CI + fail locally with 404. The
 * cross-ref / skill / workspace passes still run — only external package
 * resolution is suppressed. Real tests for the resolvers live beside them
 * and use injected fetch stubs.
 */
function isTestMode(): boolean {
  return process.env.DENO_TESTING === "true" || process.env.VITEST === "true";
}

async function validateImportedWorkspace(
  targetDir: string,
  ctx: ValidationContext,
): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  const workspaceYmlPath = join(targetDir, "workspace.yml");
  const workspaceYmlRaw = await readFile(workspaceYmlPath, "utf-8");
  const workspaceYmlParsed = parse(workspaceYmlRaw);
  const validationResult = WorkspaceConfigSchema.safeParse(workspaceYmlParsed);
  if (!validationResult.success) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: `Invalid workspace configuration: ${validationResult.error.issues.map((issue) => issue.message).join(", ")}`,
      },
    };
  }
  const report = await validateWorkspaceConfig(validationResult.data, ctx);
  if (report.status === "hard_fail") {
    return { ok: false, status: 422, body: { success: false, error: "validation_failed", report } };
  }
  return { ok: true };
}

function buildValidationContext(app: AppContext): ValidationContext {
  return {
    resolvers: isTestMode() ? [] : createDefaultResolvers(),
    skillDb: {
      has: async (namespace, name) => {
        try {
          const result = await SkillStorage.get(namespace, name);
          return result.ok && result.data != null;
        } catch {
          return true;
        }
      },
    },
    modelCatalog: { has: () => true },
    workspaceList: {
      has: async (workspaceId) => {
        try {
          const manager = app.getWorkspaceManager();
          return (await manager.find({ id: workspaceId })) != null;
        } catch {
          return true;
        }
      },
    },
  };
}

/**
 * Build a Registry with resolved MCP tool names for all servers declared in
 * a workspace config. Probes each server via createMCPTools (5s timeout) to
 * get the exact tool list. Servers that fail to probe are skipped — their
 * prefixed tools still pass via the static serverPrefixes fallback, but bare
 * tool names for those servers will not resolve.
 */
async function buildMcpToolRegistry(config: WorkspaceConfig): Promise<Registry> {
  const declaredServers = Object.keys(config.tools?.mcp?.servers ?? {});
  if (declaredServers.length === 0) return {};

  const mcpTools: Record<string, string[]> = {};

  for (const serverId of declaredServers) {
    try {
      let server: MCPServerMetadata | undefined = mcpServersRegistry.servers[serverId];
      if (!server) {
        const adapter = await getMCPRegistryAdapter();
        server = (await adapter.get(serverId)) ?? undefined;
      }
      if (!server) continue;

      const result = await createMCPTools({ [serverId]: server.configTemplate }, logger, {
        signal: AbortSignal.timeout(5000),
      });
      mcpTools[serverId] = Object.keys(result.tools);
      await result.dispose();
    } catch (error) {
      logger.warn("MCP tool probe failed during validation", {
        serverId,
        error: stringifyError(error),
      });
      // Skip this server — bare tool names won't resolve, but prefixed tools
      // still pass via the static serverPrefixes fallback in checkToolReferences.
    }
  }

  return { mcpTools, mcpServers: declaredServers };
}

/** Shared schemas for the signal endpoint (SSE + JSON handlers). */
const signalParamSchema = z.object({ workspaceId: z.string(), signalId: z.string() });
const signalBodySchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
  streamId: z.string().optional(),
  skipStates: z.array(z.string()).optional(),
});

export * from "./schemas.ts";

/** Format a job key into a display name: title > formatted key > raw key */
export function formatJobName(
  key: string,
  job: { title?: string; [key: string]: unknown },
): string {
  if (job.title) return job.title;
  const formatted = key.replace(/[-_]/g, " ");
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/**
 * Extract integration provider names for a specific job by tracing:
 * - LLM actions: tools (MCP server IDs) → credential paths → providers
 * - Agent actions: agentId → bundled agent registry → requiredConfig link providers
 */
export function extractJobIntegrations(
  job: {
    fsm?: {
      states?: Record<
        string,
        { entry?: Array<{ type: string; tools?: string[]; agentId?: string }> }
      >;
    };
  },
  config: WorkspaceConfig,
): string[] {
  const states = job.fsm?.states;
  if (!states) return [];

  const serverIds = new Set<string>();
  const agentIds = new Set<string>();

  for (const state of Object.values(states)) {
    for (const action of state.entry ?? []) {
      if (action.type === "llm" && action.tools) {
        for (const t of action.tools) serverIds.add(t);
      } else if (action.type === "agent" && action.agentId) {
        agentIds.add(action.agentId);
      }
    }
  }

  const providers = new Set<string>();

  // LLM tools → MCP server credentials → providers
  if (serverIds.size > 0) {
    const credentials = extractCredentials(config);
    for (const cred of credentials) {
      const [type, entityId] = cred.path.split(":");
      if (!cred.provider || !entityId) continue;
      if (type === "mcp" && serverIds.has(entityId)) {
        providers.add(cred.provider);
      }
    }
  }

  // Bundled agent IDs → registry requiredConfig link providers
  for (const agentId of agentIds) {
    const entry = bundledAgentsRegistry[agentId];
    if (!entry) continue;
    for (const field of entry.requiredConfig) {
      if (field.from === "link") {
        providers.add(field.provider);
      }
    }
  }

  return [...providers];
}

/**
 * Inject missing `from: link` credential refs from the bundled agent registry.
 * When a workspace uses a bundled atlas agent but the user hasn't configured
 * its required OAuth credentials, the agent's env block is empty/missing.
 * This ensures those refs are present so the credential extraction flow
 * can detect and resolve them during export/import.
 */
export { injectBundledAgentRefs } from "./inject-bundled-agents.ts";

// Create and mount routes
const workspacesRoutes = daemonFactory
  .createApp()
  // List all workspaces
  .get("/", async (c) => {
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const allWorkspaces = await manager.list({ includeSystem: true });
      const workspaces = ctx.exposeKernel
        ? allWorkspaces
        : allWorkspaces.filter((w) => w.id !== KERNEL_WORKSPACE_ID);
      const response = workspaces
        .map((w) => ({
          ...w,
          description: w.metadata?.description,
          type: w.metadata?.ephemeral ? "ephemeral" : "persistent",
          canonical: w.metadata?.canonical,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      return c.json(response);
    } catch (error) {
      return c.json({ error: `Failed to list workspaces: ${stringifyError(error)}` }, 500);
    }
  })
  // Create workspace from configuration
  .post("/create", zValidator("json", createWorkspaceFromConfigSchema), async (c) => {
    try {
      const { config, workspaceName, ephemeral } = c.req.valid("json");

      // Validate configuration
      const validationResult = WorkspaceConfigSchema.safeParse(config);
      if (!validationResult.success) {
        return c.json(
          {
            success: false,
            error: `Invalid workspace configuration: ${validationResult.error.issues
              .map((issue) => issue.message)
              .join(", ")}`,
          },
          400,
        );
      }

      let validatedConfig = validationResult.data;

      // Apply default memory baseline when the caller didn't provide any.
      if (!validatedConfig.memory || validatedConfig.memory.own.length === 0) {
        validatedConfig = { ...validatedConfig, memory: DEFAULT_WORKSPACE_MEMORY };
      }

      // Inject missing credential refs from bundled agent registry so that
      // agents requiring OAuth credentials are detected during import.
      validatedConfig = injectBundledAgentRefs(validatedConfig);

      // Preprocess id-only credential refs (from foreign/legacy workspace files).
      // Try to fetch each to discover the provider. If the credential belongs to the
      // current user, convert to a provider-only ref so the normal resolution flow
      // re-binds it. If the credential is foreign/deleted (404), strip the env var
      // so the workspace can still be created.
      const importLogger = createLogger({ component: "workspace-import" });
      const initialCredentials = extractCredentials(validatedConfig);
      const idOnlyRefs = initialCredentials.filter(
        (cred): cred is CredentialUsage & { credentialId: string } =>
          !!cred.credentialId && !cred.provider,
      );

      let strippedCredentialPaths: string[] | undefined;
      let unresolvedCredentialPaths: string[] | undefined;

      if (idOnlyRefs.length > 0) {
        const lookupResults = await Promise.allSettled(
          idOnlyRefs.map(async (ref) => {
            const credential = await fetchLinkCredential(ref.credentialId, importLogger);
            return { credentialId: ref.credentialId, provider: credential.provider };
          }),
        );

        const pathsToStrip: string[] = [];
        const idProviderMap: Record<string, string> = {};
        const expiredCredentials: Array<{ credentialId: string; path: string; status: string }> =
          [];

        for (const [i, result] of lookupResults.entries()) {
          const ref = idOnlyRefs[i];
          if (!ref) continue;
          if (result.status === "fulfilled") {
            idProviderMap[result.value.credentialId] = result.value.provider;
          } else if (result.reason instanceof LinkCredentialNotFoundError) {
            pathsToStrip.push(ref.path);
          } else if (result.reason instanceof LinkCredentialExpiredError) {
            expiredCredentials.push({
              credentialId: result.reason.credentialId,
              path: ref.path,
              status: result.reason.status,
            });
          } else {
            throw result.reason;
          }
        }

        if (expiredCredentials.length > 0) {
          return c.json(
            {
              error: "credential_expired",
              message:
                "Some credentials have expired. Re-authorize the integrations and try again.",
              expiredCredentials,
            },
            400,
          );
        }

        // Strip unresolvable refs (foreign/deleted credentials)
        if (pathsToStrip.length > 0) {
          importLogger.warn("Stripping unresolvable credential refs during import", {
            paths: pathsToStrip,
          });
          validatedConfig = stripCredentialRefs(validatedConfig, pathsToStrip);
          strippedCredentialPaths = pathsToStrip;
        }

        // Convert resolvable id-only refs to provider-only format so the
        // normal provider resolution flow re-binds them to the importing user
        if (Object.keys(idProviderMap).length > 0) {
          validatedConfig = toProviderRefs(validatedConfig, idProviderMap);
        }
      }

      // Re-extract credentials from the (potentially modified) config
      const credentials = extractCredentials(validatedConfig);
      const providerOnlyRefs = credentials.filter(
        (cred): cred is CredentialUsage & { provider: string } => !!cred.provider,
      );
      const allProviders = [...new Set(providerOnlyRefs.map((ref) => ref.provider))];

      const uniqueProviders = allProviders;

      type ResolvedCredentialInfo = {
        path: string;
        provider: string;
        credentialId: string;
        label: string;
      };
      let resolvedCredentials: ResolvedCredentialInfo[] | undefined;
      const unresolvedProviders: string[] = [];
      let ambiguousProviders:
        | Record<
            string,
            Array<{
              id: string;
              label: string;
              displayName: string | null;
              userIdentifier: string | null;
              isDefault: boolean;
            }>
          >
        | undefined;
      const invalidProviders: string[] = [];

      if (uniqueProviders.length > 0) {
        const results = await Promise.allSettled(
          uniqueProviders.map((provider) => resolveCredentialsByProvider(provider)),
        );

        const credentialMap: Record<string, string> = {};
        const labelMap: Record<string, string> = {};

        for (const [i, result] of results.entries()) {
          const provider = uniqueProviders[i] ?? "";
          if (result.status === "rejected") {
            if (result.reason instanceof InvalidProviderError) {
              invalidProviders.push(provider);
            } else if (result.reason instanceof CredentialNotFoundError) {
              unresolvedProviders.push(provider);
            } else {
              throw result.reason;
            }
          } else if (result.value.length === 1) {
            const first = result.value[0];
            if (first) {
              credentialMap[provider] = first.id;
              labelMap[provider] = first.label;
            }
          } else if (result.value.length > 1) {
            // Multiple credentials — surface ambiguity for the picker UI
            ambiguousProviders ??= {};
            ambiguousProviders[provider] = result.value.map((cred) => ({
              id: cred.id,
              label: cred.label,
              displayName: cred.displayName,
              userIdentifier: cred.userIdentifier,
              isDefault: cred.isDefault,
            }));
          }
        }

        if (invalidProviders.length > 0) {
          return c.json(
            {
              error: "missing_providers",
              message: "Cannot import workspace: required providers are not configured",
              providers: invalidProviders,
            },
            400,
          );
        }

        // Track unresolved provider refs for requires_setup flag, but keep them
        // in the config — they're declarative requirements the setup page needs
        // to show Connect buttons for MCP server credentials.
        if (unresolvedProviders.length > 0) {
          unresolvedCredentialPaths = providerOnlyRefs
            .filter((ref) => unresolvedProviders.includes(ref.provider))
            .map((ref) => ref.path);
        }

        // Apply credential IDs only for single-match providers (ambiguous excluded from map)
        validatedConfig = toIdRefs(validatedConfig, credentialMap);

        resolvedCredentials = providerOnlyRefs
          .filter((ref) => credentialMap[ref.provider])
          .map((ref) => ({
            path: ref.path,
            provider: ref.provider,
            credentialId: credentialMap[ref.provider] ?? "",
            label: labelMap[ref.provider] ?? "",
          }));
      }

      // Reference validator — catches LLM hallucinations (bad npm packages,
      // typoed agent ids, unknown skills, etc.) before they land on disk.
      // Registry-confirmed 404 and cross-ref typos are hard-fail; registry
      // network errors and private-scope auth are soft-fail and persist
      // with validationWarnings metadata on the workspace.
      const validationReport = await validateWorkspaceConfig(
        validatedConfig,
        buildValidationContext(c.get("app")),
      );
      if (validationReport.status === "hard_fail") {
        logger.warn("workspace_validation_failed", {
          workspaceName: workspaceName ?? validatedConfig.workspace.name,
          issueCount: validationReport.issues.length,
          codes: validationReport.issues.map((i) => i.code),
        });
        return c.json(
          { success: false, error: "validation_failed", report: validationReport },
          422,
        );
      }

      const yamlConfig = stringify(validatedConfig, { indent: 2, lineWidth: 100 });

      const workspaceAdapter = new FilesystemWorkspaceCreationAdapter();
      const finalWorkspaceName = workspaceName || validatedConfig.workspace.name;
      const basePath = join(getFridayHome(), "workspaces");

      try {
        const workspacePath = await workspaceAdapter.createWorkspaceDirectory(
          basePath,
          finalWorkspaceName,
        );

        await workspaceAdapter.writeWorkspaceFiles(workspacePath, yamlConfig, { ephemeral });

        // Get current user for metadata
        const userResult = await getCurrentUser();
        const userId = userResult.ok ? userResult.data?.id : undefined;

        // Register workspace with manager
        const ctx = c.get("app");
        const manager = ctx.daemon.getWorkspaceManager();
        const hasUnresolvedCredentials =
          unresolvedProviders.length > 0 ||
          ambiguousProviders !== undefined ||
          (strippedCredentialPaths !== undefined && strippedCredentialPaths.length > 0) ||
          (unresolvedCredentialPaths !== undefined && unresolvedCredentialPaths.length > 0);
        const { workspace, created } = await manager.registerWorkspace(workspacePath, {
          name: finalWorkspaceName,
          description: validatedConfig.workspace.description,
          createdBy: userId,
          skipEnvValidation: hasUnresolvedCredentials,
        });

        // Set requires_setup flag if any credentials are missing or were stripped
        if (hasUnresolvedCredentials && created) {
          await manager.updateWorkspaceStatus(workspace.id, workspace.status, {
            metadata: { ...workspace.metadata, requires_setup: true },
          });
          workspace.metadata = { ...workspace.metadata, requires_setup: true };
        }

        // Resources subsystem was deleted (Ledger). Any incoming `resources:`
        // block in the imported config is silently dropped — no-op in the new
        // world. The schema parser also strips it before we get here.

        return c.json(
          {
            success: true,
            workspace,
            created,
            workspacePath,
            filesCreated: [ephemeral ? "eph_workspace.yml" : "workspace.yml", ".env"],
            ...(resolvedCredentials && resolvedCredentials.length > 0
              ? { resolvedCredentials }
              : {}),
            ...(ambiguousProviders ? { ambiguousProviders } : {}),
            ...(strippedCredentialPaths && strippedCredentialPaths.length > 0
              ? { strippedCredentials: strippedCredentialPaths }
              : {}),
            ...(unresolvedCredentialPaths && unresolvedCredentialPaths.length > 0
              ? { unresolvedCredentials: unresolvedCredentialPaths }
              : {}),
          },
          201,
        );
      } catch (creationError) {
        return c.json(
          {
            success: false,
            error: `Failed to create workspace files: ${
              creationError instanceof Error ? creationError.message : String(creationError)
            }`,
          },
          500,
        );
      }
    } catch (error) {
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  })
  // Add a single workspace by path
  .post("/add", zValidator("json", addWorkspaceSchema), async (c) => {
    const ctx = c.get("app");
    try {
      const { path, name, description } = c.req.valid("json");

      // Get current user for metadata
      const userResult = await getCurrentUser();
      const userId = userResult.ok ? userResult.data?.id : undefined;

      const manager = ctx.daemon.getWorkspaceManager();

      const { workspace: entry, created } = await manager.registerWorkspace(path, {
        name,
        description,
        createdBy: userId,
      });

      // Convert to API response format
      const workspaceInfo = {
        id: entry.id,
        name: entry.name,
        description: entry.metadata?.description,
        status: entry.status,
        path: entry.path,
        createdAt: entry.createdAt,
        lastSeen: entry.lastSeen,
        created,
      };

      return c.json(workspaceInfo, created ? 201 : 200);
    } catch (error) {
      const message = stringifyError(error);
      logger.error("Failed to add workspace", { error: message });
      // Treat registration errors as bad requests (invalid path/config)
      if (message) return c.json({ error: message }, 400);
      return c.json({ error: `Failed to add workspace: ${message}` }, 500);
    }
  })
  // Add multiple workspaces by paths (batch operation)
  .post("/add-batch", zValidator("json", addWorkspaceBatchSchema), async (c) => {
    const ctx = c.get("app");
    try {
      const { paths } = c.req.valid("json");

      const manager = ctx.daemon.getWorkspaceManager();
      const results: {
        added: Array<{
          id: string;
          name: string;
          description?: string;
          status: string;
          path: string;
          createdAt: string;
          lastSeen: string;
          created: boolean;
        }>;
        failed: Array<{ path: string; error: string }>;
      } = { added: [], failed: [] };

      // Process paths with reasonable concurrency (5 parallel)
      const batchSize = 5;
      for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize);
        const batchPromises = batch.map(async (path) => {
          try {
            const { workspace: entry, created } = await manager.registerWorkspace(path);

            results.added.push({
              id: entry.id,
              name: entry.name,
              description: entry.metadata?.description,
              status: entry.status,
              path: entry.path,
              createdAt: entry.createdAt,
              lastSeen: entry.lastSeen,
              created,
            });
          } catch (error) {
            results.failed.push({ path, error: stringifyError(error) });
          }
        });

        await Promise.all(batchPromises);
      }

      return c.json(results, 200);
    } catch (error) {
      logger.error("Failed to add workspaces", { error });
      return c.json({ error: "Failed to add workspaces" }, 500);
    }
  })
  // Export every non-virtual workspace into a single archive. The archive
  // contains one regular bundle zip per workspace under `workspaces/`, plus a
  // top-level `manifest.yml`. `global/{skills,memory}` slots are reserved for
  // later (currently null in the manifest). System/kernel workspaces are
  // skipped because they have no on-disk layout — `isOnDiskWorkspace` filters
  // them by `stat()`.
  //
  // Declared BEFORE `/:workspaceId` so the static path wins the Hono match.
  .get("/bundle-all", async (c) => {
    const modeParam = c.req.query("mode");
    const mode: "definition" | "migration" = modeParam === "migration" ? "migration" : "definition";
    const includeParam = c.req.query("include") ?? "";
    const includeGlobalSkills = includeParam
      .split(",")
      .map((s) => s.trim())
      .includes("global-skills");
    const bundleLogger = createLogger({ component: "workspace-bundle-all-export" });
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const all = await manager.list({ includeSystem: false });
      const bundles: Array<{ id: string; name: string; bundleBytes: Uint8Array }> = [];
      const skipped: Array<{ id: string; name: string; reason: string }> = [];

      for (const ws of all) {
        if (!(await isOnDiskWorkspace(ws.path))) {
          skipped.push({
            id: ws.id,
            name: ws.name,
            reason: "virtual workspace — no on-disk directory",
          });
          continue;
        }
        const cfg = await manager.getWorkspaceConfig(ws.id);
        if (!cfg) {
          skipped.push({
            id: ws.id,
            name: ws.name,
            reason: "failed to load workspace configuration",
          });
          continue;
        }
        try {
          const built = await buildWorkspaceBundleBytes({
            workspaceId: ws.id,
            workspaceName: ws.name,
            workspacePath: ws.path,
            config: cfg,
            mode,
            logger: bundleLogger,
            ...(mode === "migration" ? { memoryDir: join(getFridayHome(), "memory", ws.id) } : {}),
          });
          bundles.push({ id: ws.id, name: built.name, bundleBytes: built.bundleBytes });
        } catch (err) {
          skipped.push({ id: ws.id, name: ws.name, reason: stringifyError(err) });
        }
      }

      let globalSkillsBytes: Uint8Array | undefined;
      let globalSkillsStatus = "not-requested";
      if (includeGlobalSkills) {
        const skillsDbPath = join(getFridayHome(), "skills.db");
        const exported = await exportGlobalSkills({ skillsDbPath });
        if (exported.bytes) {
          globalSkillsBytes = exported.bytes;
          globalSkillsStatus = "included";
        } else {
          globalSkillsStatus = "missing-source-db";
        }
      }

      const archive = await exportAll({
        workspaces: bundles,
        mode,
        ...(globalSkillsBytes ? { global: { skills: globalSkillsBytes } } : {}),
      });

      const date = new Date().toISOString().slice(0, 10);
      const filename = `atlas-full-export-${date}.zip`;
      return new Response(new Uint8Array(archive), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Atlas-Bundled-Workspaces": String(bundles.length),
          "X-Atlas-Skipped-Workspaces": String(skipped.length),
          "X-Atlas-Global-Skills": globalSkillsStatus,
        },
      });
    } catch (error) {
      const errorMessage = stringifyError(error);
      return c.json({ error: `Failed to bundle all workspaces: ${errorMessage}` }, 500);
    }
  })
  // Import every workspace from a full-instance archive. Body is multipart
  // with a single "bundle" file field (same shape as /import-bundle). Each
  // inner per-workspace bundle is imported via the regular importBundle path,
  // then registered with the workspace manager. No collision detection — each
  // imported workspace gets a fresh auto-generated ID; duplicates by name are
  // preserved, mirroring /import-bundle.
  .post("/import-bundle-all", async (c) => {
    const importLogger = createLogger({ component: "workspace-bundle-all-import" });
    try {
      const form = await c.req.formData();
      const file = form.get("bundle");
      if (!(file instanceof File)) {
        return c.json({ error: "Missing 'bundle' file in multipart form" }, 400);
      }
      const zipBytes = new Uint8Array(await file.arrayBuffer());

      const atlasHome = getFridayHome();
      const workspacesRoot = join(atlasHome, "workspaces");
      await mkdir(workspacesRoot, { recursive: true });

      const result = await importAll({ zipBytes, workspacesRoot });

      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const imported: Array<{
        workspaceId: string;
        name: string;
        path: string;
        memory?: { kind: string; path?: string; reason?: string };
      }> = [];
      const errors: Array<{ name: string; error: string }> = [...result.errors];
      for (const entry of result.imported) {
        try {
          const validation = await validateImportedWorkspace(
            entry.path,
            buildValidationContext(ctx),
          );
          if (!validation.ok) {
            await rm(entry.path, { recursive: true, force: true });
            const body = validation.body;
            errors.push({
              name: entry.name,
              error: typeof body.error === "string" ? body.error : "validation_failed",
            });
            continue;
          }
          const registered = await manager.registerWorkspace(entry.path, { name: entry.name });
          const memory = await materializeImportedMemory({
            importedWorkspaceDir: entry.path,
            atlasHome,
            newWorkspaceId: registered.workspace.id,
          });
          imported.push({
            workspaceId: registered.workspace.id,
            name: entry.name,
            path: entry.path,
            memory,
          });
        } catch (err) {
          errors.push({ name: entry.name, error: stringifyError(err) });
        }
      }

      let globalSkills:
        | { kind: string; targetPath?: string; sideloadedAs?: string; bytesWritten?: number }
        | undefined;
      if (result.globalSkillsBytes) {
        try {
          const skillsDbPath = join(atlasHome, "skills.db");
          const gs = await importGlobalSkills({ zipBytes: result.globalSkillsBytes, skillsDbPath });
          globalSkills = gs.status;
        } catch (err) {
          errors.push({ name: "global.skills", error: stringifyError(err) });
        }
      }

      return c.json({ manifest: result.manifest, imported, errors, globalSkills });
    } catch (error) {
      const errorMessage = stringifyError(error);
      importLogger.error("Bundle-all import failed", { error: errorMessage });
      return c.json({ error: `Failed to import bundle-all: ${errorMessage}` }, 500);
    }
  })
  // Get workspace details
  .get("/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace =
        (await manager.find({ id: workspaceId })) || (await manager.find({ name: workspaceId }));
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }

      // Load workspace configuration
      const config = await manager.getWorkspaceConfig(workspace.id);

      return c.json(
        {
          ...workspace,
          description: workspace.metadata?.description,
          type: workspace.metadata?.ephemeral ? "ephemeral" : "persistent",
          config: config?.workspace || null,
        },
        200,
      );
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to get workspace: ${errorMessage}` }, 500);
    }
  })
  // Export workspace configuration as YAML
  .get("/:workspaceId/export", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const exportLogger = createLogger({ component: "workspace-export" });
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json({ error: `Failed to load workspace configuration: ${workspace.id}` }, 500);
      }

      // Inject missing credential refs from bundled agent registry so they
      // appear in the exported YAML even if the user never configured them.
      const configWithAgentRefs = injectBundledAgentRefs(config.workspace);

      const credentials = extractCredentials(configWithAgentRefs);
      const legacyRefs = credentials.filter(
        (cred): cred is CredentialUsage & { credentialId: string } =>
          !cred.provider && !!cred.credentialId,
      );

      const providerMap: Record<string, string> = {};
      const unresolvedPaths: string[] = [];

      const legacyResults = await Promise.allSettled(
        legacyRefs.map(async (ref) => {
          const credential = await fetchLinkCredential(ref.credentialId, exportLogger);
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

      // Strip unresolvable legacy refs instead of failing the export.
      // The exported YAML will omit those env vars; the importing user
      // will need to configure credentials through workspace settings.
      let workspaceToExport = configWithAgentRefs;
      if (unresolvedPaths.length > 0) {
        exportLogger.warn("Stripping unresolvable credential refs from export", {
          unresolvedPaths,
        });
        workspaceToExport = stripCredentialRefs(workspaceToExport, unresolvedPaths);
      }

      const portableConfig = toProviderRefs(workspaceToExport, providerMap);

      // Strip workspace.id - it will be regenerated on import
      const { id: _id, ...workspaceIdentity } = portableConfig.workspace;
      const exportConfig = { ...portableConfig, workspace: workspaceIdentity };

      const yamlContent = stringify(exportConfig, { indent: 2, lineWidth: 100 });

      // Sanitize workspace name for filename
      const sanitizedName = workspace.name.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-");
      const filename = `${sanitizedName}.yml`;

      return new Response(yamlContent, {
        headers: {
          "Content-Type": "text/yaml",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to export workspace: ${errorMessage}` }, 500);
    }
  })
  // Export workspace as a zip bundle (POC — definition-mode only for now)
  .get("/:workspaceId/bundle", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const modeParam = c.req.query("mode");
    const mode: "definition" | "migration" = modeParam === "migration" ? "migration" : "definition";
    const bundleLogger = createLogger({ component: "workspace-bundle-export" });
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json({ error: `Failed to load workspace configuration: ${workspace.id}` }, 500);
      }

      const { bundleBytes } = await buildWorkspaceBundleBytes({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
        config,
        mode,
        logger: bundleLogger,
        ...(mode === "migration"
          ? { memoryDir: join(getFridayHome(), "memory", workspace.id) }
          : {}),
      });

      const sanitizedName = workspace.name.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-");
      const filename = `${sanitizedName}.zip`;
      return new Response(new Uint8Array(bundleBytes), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to bundle workspace: ${errorMessage}` }, 500);
    }
  })
  // Import a workspace from a zip bundle.
  // Body: multipart/form-data with a single "bundle" file field.
  .post("/import-bundle", async (c) => {
    const importLogger = createLogger({ component: "workspace-bundle-import" });
    try {
      const form = await c.req.formData();
      const file = form.get("bundle");
      if (!(file instanceof File)) {
        return c.json({ error: "Missing 'bundle' file in multipart form" }, 400);
      }
      const zipBytes = new Uint8Array(await file.arrayBuffer());

      const atlasHome = getFridayHome();
      const importRoot = join(atlasHome, "workspaces");
      await mkdir(importRoot, { recursive: true });
      const uniqueSuffix = Date.now().toString(36);
      const targetDir = join(importRoot, `imported-${uniqueSuffix}`);

      const result = await importBundle({ zipBytes, targetDir });

      const ctx = c.get("app");
      const validation = await validateImportedWorkspace(targetDir, buildValidationContext(ctx));
      if (!validation.ok) {
        await rm(targetDir, { recursive: true, force: true });
        return c.json(validation.body, validation.status as 400 | 422 | 500);
      }

      const manager = ctx.getWorkspaceManager();
      const registered = await manager.registerWorkspace(targetDir, {
        name: result.lockfile.workspace.name,
      });

      // If the bundle carried migration-mode memory, relocate it from the
      // imported workspace dir to `<atlasHome>/memory/<new-id>/narrative/`
      // where the daemon expects it.
      const memory = await materializeImportedMemory({
        importedWorkspaceDir: targetDir,
        atlasHome,
        newWorkspaceId: registered.workspace.id,
      });

      return c.json({
        workspaceId: registered.workspace.id,
        path: targetDir,
        name: result.lockfile.workspace.name,
        primitives: result.primitives,
        memory,
      });
    } catch (error) {
      const errorMessage = stringifyError(error);
      importLogger.error("Bundle import failed", { error: errorMessage });
      return c.json({ error: `Failed to import bundle: ${errorMessage}` }, 500);
    }
  })
  // Get workspace configuration
  .get("/:workspaceId/config", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json({ error: `Failed to load workspace configuration: ${workspace.id}` }, 500);
      }
      return c.json({
        config: config.workspace,
        type: workspace.metadata?.ephemeral ? "ephemeral" : "persistent",
        expiresAt: workspace.metadata?.expiresAt,
      });
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to get workspace config: ${errorMessage}` }, 500);
    }
  })
  // Lint a persisted workspace's config. Read-only — never mutates.
  // Exists so existing broken workspaces (e.g. created before validation
  // was added, or by an older hallucinating LLM turn) can be audited
  // without forcing the user to recreate them.
  .post("/:workspaceId/lint", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json({ error: `Failed to load workspace configuration: ${workspace.id}` }, 500);
      }
      const report = await validateWorkspaceConfig(config.workspace, buildValidationContext(ctx));
      return c.json({ report });
    } catch (error) {
      return c.json({ error: `Failed to lint workspace: ${stringifyError(error)}` }, 500);
    }
  })
  // Update workspace configuration
  .post(
    "/:workspaceId/update",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("json", updateWorkspaceConfigSchema),
    async (c) => {
      try {
        const { workspaceId } = c.req.valid("param");
        const { config, backup, force } = c.req.valid("json");

        const ctx = c.get("app");
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ success: false, error: `Workspace not found: ${workspaceId}` }, 400);
        }

        // Active-session guard. Refuse to destroy a runtime mid-session unless
        // the caller explicitly passes force=true. Matches the failure mode
        // documented in the FAST self-modification skill: operator edits
        // workspace.yml while a session is running, runtime tears down,
        // session dies with "MCP error -32000: Connection closed".
        if (!force) {
          const currentRuntime = ctx.getWorkspaceRuntime(workspaceId);
          if (currentRuntime) {
            const sessions = currentRuntime.getSessions();
            const activeSessions = sessions.filter(
              (s: { session: { status: string; id: string } }) => s.session.status === "active",
            );
            let hasActiveExecutions = false;
            if (
              "getOrchestrator" in currentRuntime &&
              typeof currentRuntime.getOrchestrator === "function"
            ) {
              const orchestrator = currentRuntime.getOrchestrator();
              hasActiveExecutions = orchestrator.hasActiveExecutions();
            }
            if (activeSessions.length > 0 || hasActiveExecutions) {
              return c.json(
                {
                  success: false,
                  error:
                    "Workspace has active sessions or executions. Pass force=true to override.",
                  activeSessionIds: activeSessions.map(
                    (s: { session: { id: string } }) => s.session.id,
                  ),
                  hasActiveExecutions,
                },
                409,
              );
            }
          }
        }

        const validationResult = WorkspaceConfigSchema.safeParse(config);
        if (!validationResult.success) {
          return c.json(
            {
              success: false,
              error: `Invalid workspace configuration: ${validationResult.error.issues
                .map((issue) => issue.message)
                .join(", ")}`,
            },
            400,
          );
        }

        const validatedConfig = validationResult.data;
        const yamlConfig = stringify(validatedConfig, { indent: 2, lineWidth: 100 });
        const workspacePath = workspace.path;
        const workspaceYmlPath = join(workspacePath, "workspace.yml");

        try {
          if (backup) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupPath = join(workspacePath, `workspace.yml.backup-${timestamp}`);
            try {
              const existingContent = await readFile(workspaceYmlPath, "utf-8");
              await writeFile(backupPath, existingContent, "utf-8");
            } catch (backupError) {
              return c.json(
                {
                  success: false,
                  error: `Failed to create backup: ${
                    backupError instanceof Error ? backupError.message : String(backupError)
                  }`,
                },
                500,
              );
            }
          }

          await writeFile(workspaceYmlPath, yamlConfig, "utf-8");

          // Keep the registry's shadow `name` in sync with the yml. UI and
          // bundle export otherwise disagree: UI reads config.workspace.name,
          // bundle filename reads registry name.
          const ymlName = validatedConfig.workspace.name;
          if (ymlName && ymlName !== workspace.name) {
            await manager.updateWorkspaceStatus(workspace.id, workspace.status, { name: ymlName });
          }

          // We do NOT call destroyWorkspaceRuntime here, even on success. The
          // file watcher detects the workspace.yml write and routes the change
          // through WorkspaceManager.handleWatcherChange, which defers the
          // runtime swap until any active session or in-flight execution
          // finishes (handleWorkspaceConfigChange → stopRuntimeIfActive). When
          // the chat agent itself triggers the update, that deferral is what
          // keeps the chat alive — the prior implementation tore down the
          // runtime synchronously and killed the conversation mid-stream.
          return c.json({
            success: true,
            workspace,
            runtimeReloaded: ctx.getWorkspaceRuntime(workspace.id) !== undefined,
            message: "Config written; runtime reload deferred to file-watcher path",
          });
        } catch (updateError) {
          return c.json(
            {
              success: false,
              error: `Failed to update workspace files: ${
                updateError instanceof Error ? updateError.message : String(updateError)
              }`,
            },
            500,
          );
        }
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  // Toggle persistence
  .post(
    "/:workspaceId/persistence",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("json", z.object({ persistent: z.boolean() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { persistent } = c.req.valid("json");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        await manager.updateWorkspacePersistence(workspaceId, persistent);
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        return c.json({
          ...workspace,
          description: workspace.metadata?.description,
          type: workspace.metadata?.ephemeral ? "ephemeral" : "persistent",
        });
      } catch (error) {
        return c.json({ error: `Failed to update persistence: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Update workspace metadata
  .patch(
    "/:workspaceId/metadata",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator(
      "json",
      z.object({
        name: z.string().min(1).optional(),
        color: ColorSchema.optional(),
        description: z.string().optional(),
      }),
    ),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { name, ...metadataUpdates } = c.req.valid("json");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        if (name && workspace.metadata?.canonical === "system") {
          return c.json({ error: "Cannot rename system canonical workspace" }, 403);
        }

        const newMetadata = { ...workspace.metadata, ...metadataUpdates };
        await manager.updateWorkspaceStatus(workspaceId, workspace.status, {
          ...(name ? { name } : {}),
          metadata: newMetadata,
        });

        const updated = { ...workspace, metadata: newMetadata, ...(name ? { name } : {}) };
        return c.json(updated, 200);
      } catch (error) {
        return c.json({ error: `Failed to update metadata: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Complete workspace setup (verify all credentials are connected)
  .post(
    "/:workspaceId/setup/complete",
    zValidator("param", z.object({ workspaceId: z.string() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        const config = await manager.getWorkspaceConfig(workspace.id);
        if (!config) {
          return c.json({ error: "Failed to load workspace configuration" }, 500);
        }

        const credentials = extractCredentials(config.workspace);

        // Group by provider and check each has a credentialId
        const byProvider = new Map<string, boolean>();
        for (const cred of credentials) {
          if (!cred.provider) continue;
          const currentlyConnected = byProvider.get(cred.provider) ?? true;
          byProvider.set(cred.provider, currentlyConnected && !!cred.credentialId);
        }

        const missingProviders = [...byProvider.entries()]
          .filter(([, connected]) => !connected)
          .map(([provider]) => provider);

        if (missingProviders.length > 0) {
          return c.json({ error: "incomplete_setup", missingProviders }, 422);
        }

        // All credentials connected — clear requires_setup
        const newMetadata = { ...workspace.metadata, requires_setup: false };
        await manager.updateWorkspaceStatus(workspaceId, workspace.status, {
          metadata: newMetadata,
        });

        return c.json({ ok: true }, 200);
      } catch (error) {
        return c.json({ error: `Failed to complete setup: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Connect a communicator (slack/telegram/discord/teams/whatsapp) to a
  // workspace. Wires the credential to the workspace via Link's
  // communicator_wiring table (single source of truth for secrets) and adds
  // a kind-only block to workspace.yml for visibility.
  .post(
    "/:workspaceId/connect-communicator",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator(
      "json",
      z.object({ kind: CommunicatorKindSchema, credential_id: z.string().min(1) }),
    ),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { kind, credential_id } = c.req.valid("json");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        // Derive routing-key from the credential before wiring. For telegram
        // this is the bot's app id (`bot_token` prefix). Other kinds default
        // to `credential_id` itself.
        const connectionId = await deriveConnectionId(kind, credential_id);

        // Tunnel must be up: registerWebhook needs a public URL to give upstream
        // platforms. Resolve up front so we fail clean BEFORE touching any
        // persistent state — Link's /wire would itself reject the call without
        // a callback URL anyway.
        const callbackBaseUrl = await resolveTunnelUrl();

        // Wire FIRST. If Link wire fails we must NOT touch yml — the wiring
        // table is the source of truth, and a yml block without a Link row
        // would route messages to a workspace whose secrets we can't resolve.
        await wireCommunicator(workspaceId, kind, credential_id, connectionId, callbackBaseUrl);

        // Idempotent yml mutation. If this fails, the wiring stays — a retry
        // will see the existing wiring and re-attempt the yml write.
        const mutationResult = await applyMutation(workspace.path, setCommunicatorMutation(kind));
        if (!mutationResult.ok) {
          logger.error("connect_communicator_mutation_failed", {
            workspaceId,
            kind,
            credentialId: credential_id,
            error: mutationResult.error,
          });
          return mapMutationError(c, mutationResult.error, "Communicator mutation conflicted");
        }

        await ctx.evictChatSdkInstance(workspaceId);

        // connectionId is intentionally omitted — for telegram it's the
        // post-colon half of the bot token, which is semi-sensitive (full
        // token = bot takeover). Log existence only.
        logger.info("communicator_connected_to_workspace", {
          workspaceId,
          kind,
          credentialId: credential_id,
        });
        return c.json({ ok: true, kind }, 200);
      } catch (error) {
        logger.error("connect_communicator_failed", { workspaceId, kind, error });
        return c.json({ error: `Failed to connect ${kind}: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Disconnect a communicator from a workspace. Removes the wiring row in
  // Link, removes the kind block from workspace.yml, and evicts the chat-sdk
  // so the next message dispatch picks up the absence.
  .post(
    "/:workspaceId/disconnect-communicator",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("json", z.object({ kind: CommunicatorKindSchema })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { kind } = c.req.valid("json");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        // Mutate yml first — if the write fails we must not delete the Link
        // wiring on top of a still-referencing yml block.
        const mutationResult = await applyMutation(
          workspace.path,
          removeCommunicatorMutation(kind),
        );
        if (!mutationResult.ok) {
          logger.error("disconnect_communicator_mutation_failed", {
            workspaceId,
            kind,
            error: mutationResult.error,
          });
          return mapMutationError(c, mutationResult.error, "Communicator mutation conflicted");
        }

        // Tunnel-tolerant: user intent is to disconnect — don't strand them on
        // tunnel unreachability. Link's `unregisterWebhook` hook is itself
        // best-effort and tolerates an empty callback URL.
        let callbackBaseUrl = "";
        try {
          callbackBaseUrl = await resolveTunnelUrl();
        } catch (error) {
          logger.warn("disconnect_communicator_tunnel_unavailable", {
            workspaceId,
            kind,
            error: stringifyError(error),
          });
        }

        const { credentialId } = await disconnectCommunicator(workspaceId, kind, callbackBaseUrl);

        await ctx.evictChatSdkInstance(workspaceId);

        logger.info("communicator_disconnected_from_workspace", {
          workspaceId,
          kind,
          credentialId,
        });
        return c.json({ ok: true, credential_id: credentialId }, 200);
      } catch (error) {
        logger.error("disconnect_communicator_failed", { workspaceId, kind, error });
        return c.json({ error: `Failed to disconnect ${kind}: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Trigger a workspace signal (SSE mode)
  // Registered as a separate middleware before the JSON handler so the SSE return
  // type doesn't widen the JSON handler's inferred type (Hono RPC client derives
  // response shape from return type — mixing stream + json breaks inference).
  .post("/:workspaceId/signals/:signalId", async (c, next) => {
    if (!c.req.header("accept")?.includes("text/event-stream")) {
      return next();
    }

    const paramResult = signalParamSchema.safeParse(c.req.param());
    if (!paramResult.success) {
      return c.json({ error: paramResult.error.message }, 400);
    }
    const { workspaceId, signalId } = paramResult.data;

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const bodyResult = signalBodySchema.safeParse(rawBody);
    if (!bodyResult.success) {
      return c.json({ error: bodyResult.error.message }, 400);
    }
    const body = bodyResult.data;
    const ctx = c.get("app");

    // Pre-stream validation: return HTTP error before committing to SSE stream
    const manager = ctx.daemon.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
    }

    const encoder = new TextEncoder();
    const correlationId = crypto.randomUUID();
    const nc = ctx.daemon.getNatsConnection();

    // Subscribe to both subjects BEFORE publishing so a fast worker doesn't
    // beat us to either. The stream subscription forwards every chunk the
    // worker publishes; the response subscription delivers the terminal
    // {ok, result} envelope and triggers SSE close.
    const streamSub = nc.subscribe(`signals.stream.${correlationId}`);
    const responsePromise = awaitSignalCompletion(nc, correlationId, 600_000);

    // Capture the spawned session's id from the live stream so we can cancel
    // it on client disconnect. Without this, an aborted chat-tool fetch only
    // tears down the SSE response — the daemon-side session keeps running
    // and any side-effects already in flight (send-email, post-to-slack,
    // etc.) finish anyway. Caused observed email storms when chat follow-ups
    // aborted prior turns mid-job.
    let spawnedSessionId: string | undefined;
    // The Hono request's underlying AbortSignal fires when the client
    // disconnects (browser navigates away, fetch is aborted, etc.).
    const clientAbort = c.req.raw.signal;
    const onClientAbort = () => {
      if (!spawnedSessionId) return;
      try {
        const runtime = ctx.getWorkspaceRuntime(workspaceId);
        runtime?.cancelSession(spawnedSessionId);
      } catch (err) {
        logger.warn("Failed to cancel spawned session on client disconnect", {
          workspaceId,
          signalId,
          sessionId: spawnedSessionId,
          error: stringifyError(err),
        });
      }
    };
    clientAbort.addEventListener("abort", onClientAbort, { once: true });

    const sseStream = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (bytes: Uint8Array) => {
          try {
            controller.enqueue(bytes);
            return true;
          } catch (err) {
            logger.debug("Client disconnected during signal SSE stream", {
              workspaceId,
              signalId,
              error: err,
            });
            return false;
          }
        };

        // Forward NATS-published chunks to the SSE client AND watch for the
        // session-start chunk so we know which session to cancel if the
        // client later disconnects mid-run.
        const forward = (async () => {
          for await (const msg of streamSub) {
            const decoded = new TextDecoder().decode(msg.data);
            if (!spawnedSessionId) {
              try {
                const parsed = JSON.parse(decoded) as {
                  type?: string;
                  data?: { sessionId?: string };
                };
                if (parsed.type === "data-session-start" && parsed.data?.sessionId) {
                  spawnedSessionId = parsed.data.sessionId;
                }
              } catch {
                // Not JSON or schema mismatch — keep streaming.
              }
            }
            if (!safeEnqueue(encoder.encode(`data: ${decoded}\n\n`))) {
              break;
            }
          }
        })();

        try {
          await ctx.daemon.publishSignalToJetStream({
            workspaceId,
            signalId,
            payload: body.payload,
            streamId: body.streamId,
            correlationId,
          });

          const response = await responsePromise;

          if (response.ok) {
            const result = response.result as {
              sessionId: string;
              output: Array<{ id: string; type: string; data: Record<string, unknown> }>;
            };
            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "job-complete",
                  data: {
                    success: true,
                    sessionId: result.sessionId,
                    status: "completed",
                    output: result.output,
                  },
                })}\n\n`,
              ),
            );
          } else {
            logger.error("Signal trigger SSE error", {
              error: response.error,
              workspaceId,
              signalId,
            });
            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "job-error", data: { error: response.error } })}\n\n`,
              ),
            );
          }
          safeEnqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          const errorMessage = stringifyError(error);
          logger.error("Signal trigger SSE error", { error: errorMessage, workspaceId, signalId });
          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "job-error", data: { error: errorMessage } })}\n\n`,
            ),
          );
          safeEnqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          streamSub.unsubscribe();
          await forward.catch(() => undefined);
          // SSE finished cleanly — the session has already terminated, so
          // there's nothing to cancel on client abort. Drop the listener.
          clientAbort.removeEventListener("abort", onClientAbort);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    return new Response(sseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  })
  // Trigger a workspace signal (JSON mode).
  //
  // Publishes onto the SIGNALS JetStream stream with a correlationId, then
  // awaits the response on signals.responses.<correlationId>. The shared
  // SignalConsumer in the daemon (or a future cross-process worker) dispatches
  // the cascade and publishes the result. Cascade behavior is unchanged from
  // the legacy in-process path; the difference is durability + worker-pool
  // dispatchability, plus skipStates is no longer plumbed through (cron / fs-
  // watch / HTTP all converge on the same envelope shape now).
  .post(
    "/:workspaceId/signals/:signalId",
    zValidator("param", signalParamSchema),
    zValidator("json", signalBodySchema),
    async (c) => {
      const { workspaceId, signalId } = c.req.valid("param");
      const { payload, streamId, skipStates: _skipStates } = c.req.valid("json");
      const ctx = c.get("app");

      const correlationId = crypto.randomUUID();
      const nc = ctx.daemon.getNatsConnection();

      // Same client-disconnect-cancels-spawned-session protection as the SSE
      // handler above. Capture sessionId from the live stream subject (we
      // don't forward the chunks anywhere — this subscription is purely for
      // discovery), and cancel on `c.req.raw.signal` abort.
      let spawnedSessionId: string | undefined;
      const discoverySub = nc.subscribe(`signals.stream.${correlationId}`);
      const discovery = (async () => {
        for await (const msg of discoverySub) {
          if (spawnedSessionId) break;
          try {
            const parsed = JSON.parse(new TextDecoder().decode(msg.data)) as {
              type?: string;
              data?: { sessionId?: string };
            };
            if (parsed.type === "data-session-start" && parsed.data?.sessionId) {
              spawnedSessionId = parsed.data.sessionId;
              break;
            }
          } catch {
            /* keep listening */
          }
        }
      })();
      discovery.catch(() => undefined);
      const clientAbort = c.req.raw.signal;
      const onClientAbort = () => {
        if (!spawnedSessionId) return;
        try {
          const runtime = ctx.getWorkspaceRuntime(workspaceId);
          runtime?.cancelSession(spawnedSessionId);
        } catch (err) {
          logger.warn("Failed to cancel spawned session on client disconnect", {
            workspaceId,
            signalId,
            sessionId: spawnedSessionId,
            error: stringifyError(err),
          });
        }
      };
      clientAbort.addEventListener("abort", onClientAbort, { once: true });

      try {
        // Subscribe BEFORE publishing — a fast consumer could otherwise
        // beat us to the response subject and we'd miss the reply.
        const responsePromise = awaitSignalCompletion(nc, correlationId, 600_000);
        await ctx.daemon.publishSignalToJetStream({
          workspaceId,
          signalId,
          payload,
          streamId,
          correlationId,
        });
        const response = await responsePromise;

        if (!response.ok) {
          throw new Error(response.error);
        }
        const result = response.result as {
          sessionId: string;
          output: Array<{ id: string; type: string; data: Record<string, unknown> }>;
        };
        return c.json({
          message: "Signal completed",
          status: "completed" as const,
          workspaceId,
          signalId,
          sessionId: result.sessionId,
          output: result.output,
        });
      } catch (error) {
        const errorMessage = stringifyError(error);
        if (error instanceof SessionFailedError) {
          logger.warn("Signal session failed", { error });
          return c.json({ error: errorMessage }, 422);
        }
        if (error instanceof UserConfigurationError) {
          logger.warn("Signal skipped due to user configuration error", { error });
          return c.json({ error: errorMessage }, 422);
        }
        if (error instanceof WorkspaceNotFoundError) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        if (error instanceof MissingEnvironmentError) {
          logger.warn("Workspace has missing required environment variables", {
            error,
            workspaceId,
          });
          return c.json({ error: "Workspace has missing required environment variables" }, 422);
        }
        logger.error("Failed to process signal", { error });
        if (errorMessage.includes("Workspace path does not exist")) {
          return c.json(
            {
              error: `Workspace '${workspaceId}' is not running. The workspace directory is unavailable.`,
            },
            422,
          );
        }
        if (
          errorMessage.includes("No FSM job handles signal") ||
          errorMessage.includes("Signal not found")
        ) {
          return c.json(
            { error: `Signal '${signalId}' not found in workspace '${workspaceId}'` },
            404,
          );
        }
        if (errorMessage.includes("payload validation failed")) {
          return c.json({ error: errorMessage }, 400);
        }
        if (errorMessage.includes("already has an active session")) {
          return c.json({ error: errorMessage }, 409);
        }
        return c.json({ error: `Failed to process signal: ${errorMessage}` }, 500);
      } finally {
        clientAbort.removeEventListener("abort", onClientAbort);
        discoverySub.unsubscribe();
        await discovery.catch(() => undefined);
      }
    },
  )
  // List jobs in a workspace
  .get("/:workspaceId/jobs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    const manager = ctx.getWorkspaceManager();
    const config = await manager.getWorkspaceConfig(workspaceId);
    if (!config) {
      return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
    }
    const workspaceConfig = config.workspace;
    const jobs = workspaceConfig?.jobs || {};

    return c.json(
      Object.entries(jobs).map(([key, job]) => ({
        id: key,
        name: formatJobName(key, job),
        description: job.description,
        integrations: extractJobIntegrations(job, workspaceConfig),
      })),
    );
  })
  // Get workspace sessions
  .get("/:workspaceId/sessions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }

      const runtime = ctx.daemon.runtimes.get(workspace.id);
      if (!runtime) {
        return c.json([]); // No runtime = no sessions
      }

      const sessions = runtime.listSessions();
      return c.json(sessions);
    } catch (error) {
      logger.error("Failed to list workspace sessions", { error, workspaceId });
      return c.json({ error: `Failed to list workspace sessions: ${stringifyError(error)}` }, 500);
    }
  })
  // List signals in a workspace
  .get("/:workspaceId/signals", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const signals = runtime.listSignals();
      return c.json({ signals: signals.map((signal) => ({ name: signal.id, signal })) }, 200);
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      if (error instanceof MissingEnvironmentError) {
        logger.warn("Workspace has missing required environment variables", { error, workspaceId });
        return c.json({ error: "Workspace has missing required environment variables" }, 422);
      }
      const errorMessage = stringifyError(error);
      // When workspace path doesn't exist (stopped/deleted workspace), fall back to config
      if (errorMessage.includes("Workspace path does not exist")) {
        logger.debug("Workspace path unavailable, reading signals from config", { workspaceId });
        const manager = ctx.getWorkspaceManager();
        const config = await manager.getWorkspaceConfig(workspaceId);
        const signals = config?.workspace?.signals || {};
        return c.json(
          {
            signals: Object.entries(signals).map(([id, signalConfig]) => ({
              name: id,
              signal: {
                id,
                description: signalConfig.description,
                provider: signalConfig.provider,
              },
            })),
          },
          200,
        );
      }
      logger.error("Failed to list signals", { error, workspaceId });
      return c.json({ error: `Failed to list signals: ${errorMessage}` }, 500);
    }
  })
  // Describe specific agent in a workspace
  .get("/:workspaceId/agents/:agentId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const agentId = c.req.param("agentId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const agent = runtime.describeAgent(agentId);
      return c.json(agent, 200);
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      if (error instanceof MissingEnvironmentError) {
        logger.warn("Workspace has missing required environment variables", { error, workspaceId });
        return c.json({ error: "Workspace has missing required environment variables" }, 422);
      }
      logger.error("Failed to describe agent", { error, workspaceId, agentId });
      return c.json({ error: `Failed to describe agent: ${stringifyError(error)}` }, 500);
    }
  })
  // List agents in a workspace
  .get("/:workspaceId/agents", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const agents = runtime.listAgents();
      return c.json(agents);
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      if (error instanceof MissingEnvironmentError) {
        logger.warn("Workspace has missing required environment variables", { error, workspaceId });
        return c.json({ error: "Workspace has missing required environment variables" }, 422);
      }
      logger.error("Failed to list agents", { error, workspaceId });
      return c.json({ error: `Failed to list agents: ${stringifyError(error)}` }, 500);
    }
  })
  // Delete a workspace
  .delete(
    "/:workspaceId",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("query", z.object({ force: z.literal("true").optional() }).optional()),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");

      const force = c.req.valid("query")?.force === "true";

      try {
        const manager = ctx.daemon.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });

        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        if (workspace.metadata?.canonical && !force) {
          return c.json({ error: `Cannot delete canonical workspace '${workspaceId}'` }, 403);
        }

        // Check if workspace is inside the daemon's friday-home dir
        const fridayDir = getFridayHome();
        const workspacePath = workspace.path;

        if (workspacePath.startsWith(fridayDir)) {
          // Create unregistered directory if it doesn't exist
          const unregisteredDir = join(fridayDir, "unregistered");
          await mkdir(unregisteredDir, { recursive: true });

          // Move workspace to unregistered folder with collision handling
          const workspaceName = workspacePath.split("/").pop() || workspaceId;
          let targetPath = join(unregisteredDir, workspaceName);
          let counter = 1;

          // Find an available name if there's a collision
          while (true) {
            try {
              await stat(targetPath);
              // Path exists, try next number
              counter++;
              targetPath = join(unregisteredDir, `${workspaceName}-${counter}`);
            } catch (error) {
              // Path doesn't exist (NotFound error), we can use it
              if (isErrnoException(error) && error.code === "ENOENT") {
                break;
              }
              // Some other error, throw it
              throw error;
            }
          }

          try {
            await rename(workspacePath, targetPath);
            logger.info("Moved workspace to unregistered", {
              workspaceId,
              oldPath: workspacePath,
              newPath: targetPath,
            });
          } catch (error) {
            logger.warn("Failed to move workspace to unregistered", {
              error,
              workspaceId,
              workspacePath,
            });
            // Continue with deletion even if move fails
          }
        }

        await manager.deleteWorkspace(workspaceId, { force });
        return c.json({ message: `Workspace ${workspaceId} deleted` });
      } catch (error) {
        logger.error("Failed to delete workspace", { error, workspaceId });
        return c.json({ error: `Failed to delete workspace: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // ─── WORKSPACE SKILLS (resolved) ──────────────────────────────────────────
  .get(
    "/:workspaceId/skills",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const skills = await resolveVisibleSkills(workspaceId, SkillStorage);
      return c.json({ skills });
    },
  )
  // ─── CLASSIFIED WORKSPACE SKILLS ──────────────────────────────────────────
  // Returns disjoint buckets so the playground Skills page can render
  // without per-skill N+1 assignment lookups:
  //   - assigned: skills workspace-level assigned to this workspace
  //               (job_name IS NULL)
  //   - global:   skills with zero assignments at any layer
  //   - other:    skills assigned somewhere else but not here
  //
  // Job-level rows for THIS workspace are excluded — they're surfaced on
  // the per-job detail route.
  .get(
    "/:workspaceId/skills/classified",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const listResult = await SkillStorage.list(undefined, undefined, true);
      if (!listResult.ok) return c.json({ error: listResult.error }, 500);
      const allSkills = listResult.data;

      const wsAssignedResult = await SkillStorage.listAssigned(workspaceId);
      const wsAssignedIds = new Set(
        (wsAssignedResult.ok ? wsAssignedResult.data : []).map((s) => s.skillId),
      );

      const assignmentEntries = await Promise.all(
        allSkills.map(async (skill) => {
          const r = await SkillStorage.listAssignments(skill.skillId);
          return [skill.skillId, r.ok ? r.data : []] as const;
        }),
      );
      const assignmentsBySkill = new Map(assignmentEntries);

      const assigned: typeof allSkills = [];
      const global: typeof allSkills = [];
      const other: typeof allSkills = [];
      for (const skill of allSkills) {
        const list = assignmentsBySkill.get(skill.skillId) ?? [];
        if (list.length === 0) {
          global.push(skill);
        } else if (wsAssignedIds.has(skill.skillId)) {
          assigned.push(skill);
        } else {
          other.push(skill);
        }
      }

      return c.json({ assigned, global, other });
    },
  )
  // ─── JOB SKILLS (for /platform/:ws/jobs/:jobName) ─────────────────────────
  .get(
    "/:workspaceId/jobs/:jobName/skills",
    zValidator("param", z.object({ workspaceId: z.string().min(1), jobName: z.string().min(1) })),
    async (c) => {
      const { workspaceId, jobName } = c.req.valid("param");

      const [catalogResult, inheritedSkills, jobAssignedResult] = await Promise.all([
        SkillStorage.list(undefined, undefined, true),
        resolveVisibleSkills(workspaceId, SkillStorage),
        SkillStorage.listAssignmentsForJob(workspaceId, jobName),
      ]);
      if (!catalogResult.ok) return c.json({ error: catalogResult.error }, 500);

      const catalog = catalogResult.data;
      const jobAssigned = jobAssignedResult.ok ? jobAssignedResult.data : [];

      const inheritedIds = new Set(inheritedSkills.map((s) => s.skillId));
      const jobIds = new Set(jobAssigned.map((s) => s.skillId));

      const workspaceInherited = inheritedSkills.filter((s) => s.namespace !== "friday");
      const jobSpecific = jobAssigned;
      const friday: typeof catalog = [];
      const available: typeof catalog = [];

      for (const skill of catalog) {
        if (skill.name === null || skill.name === "" || skill.disabled) continue;
        if (skill.namespace === "friday") {
          friday.push(skill);
          continue;
        }
        if (inheritedIds.has(skill.skillId) || jobIds.has(skill.skillId)) continue;
        available.push(skill);
      }

      return c.json({ workspaceInherited, jobSpecific, friday, available });
    },
  )
  // ─── PER-JOB SKILL BREAKDOWN (for /platform/:ws/skills) ───────────────────
  .get(
    "/:workspaceId/skills/job-breakdown",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace =
        (await manager.find({ id: workspaceId })) || (await manager.find({ name: workspaceId }));
      if (!workspace) return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);

      const config = await manager.getWorkspaceConfig(workspace.id);
      const jobNames = Object.keys(config?.workspace?.jobs ?? {});

      const entries = await Promise.all(
        jobNames.map(async (jobName) => {
          const r = await SkillStorage.listAssignmentsForJob(workspace.id, jobName);
          return { jobName, skills: r.ok ? r.data : [] };
        }),
      );

      const byJob = entries.filter((e) => e.skills.length > 0);
      return c.json({ byJob });
    },
  )
  // ─── DRAFT FILE FLOW ────────────────────────────────────────────────────
  .post(
    "/:workspaceId/draft/begin",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const result = await beginDraft(workspace.path);
        if (!result.ok) {
          return c.json({ success: false, error: result.error }, 400);
        }
        return c.json({ success: true, draftPath: result.value.draftPath }, 200);
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  .get(
    "/:workspaceId/draft",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const result = await readDraft(workspace.path);
        if (!result.ok) {
          return c.json({ success: false, error: result.error }, 409);
        }
        return c.json({ success: true, config: result.value }, 200);
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  .post(
    "/:workspaceId/draft/publish",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const draftResult = await readDraft(workspace.path);
        let registry: Registry | undefined;
        if (draftResult.ok) {
          registry = await buildMcpToolRegistry(draftResult.value);
        }
        const result = await publishDraft(workspace.path, registry);
        if (!result.ok) {
          if (result.error === "No draft to publish") {
            return c.json({ success: false, error: result.error }, 409);
          }
          return c.json({ success: false, error: result.error, report: result.report }, 422);
        }

        return c.json({ success: true, livePath: result.value.livePath }, 200);
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  .post(
    "/:workspaceId/draft/discard",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const result = await discardDraft(workspace.path);
        if (!result.ok) {
          return c.json({ success: false, error: result.error }, 409);
        }
        return c.json({ success: true }, 200);
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  // ─── DIRECT ITEM UPSERT (live config) ───────────────────────────────────
  // Upsert an entity (agent/signal/job/memory-own/memory-mount) into the live config.
  // Refuses the write if structural validation errors exist.
  .post(
    "/:workspaceId/items/:kind",
    zValidator(
      "param",
      z.object({
        workspaceId: z.string().min(1),
        kind: z.enum(["agent", "signal", "job", "memory-own", "memory-mount"] as const),
      }),
    ),
    zValidator(
      "json",
      z.object({ id: z.string().min(1), config: z.record(z.string(), z.unknown()) }),
    ),
    async (c) => {
      const { workspaceId, kind } = c.req.valid("param");
      const { id, config } = c.req.valid("json");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const result =
          kind === "memory-own" || kind === "memory-mount"
            ? await upsertLiveMemoryEntry(workspace.path, kind as MemoryItemKind, id, config)
            : await upsertLiveItem(workspace.path, kind as DraftItemKind, id, config);
        if (!result.ok) {
          return c.json({ ok: false, error: result.error }, 500);
        }
        const value = result.value;
        const responseBody = {
          ok: value.ok,
          diff: value.diff,
          structural_issues: value.structuralIssues,
        };
        if (!value.ok) {
          return c.json(responseBody, 422);
        }
        return c.json(responseBody, 200);
      } catch (error) {
        return c.json({ ok: false, error: stringifyError(error) }, 500);
      }
    },
  )
  // ─── DIRECT ITEM DELETE (live config) ───────────────────────────────────
  // Delete an entity (agent/signal/job) from the live config.
  // Refuses the operation if the entity is referenced by other items.
  .delete(
    "/:workspaceId/items/:kind/:id",
    zValidator(
      "param",
      z.object({
        workspaceId: z.string().min(1),
        kind: z.enum(["agent", "signal", "job"] as const),
        id: z.string().min(1),
      }),
    ),
    async (c) => {
      const { workspaceId, kind, id } = c.req.valid("param");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const result = await removeLiveItem(workspace.path, kind as DraftItemKind, id);
        if (!result.ok) {
          if (result.reason === "referenced") {
            return c.json(
              { ok: false, error: { code: "referenced", dependents: result.dependents } },
              422,
            );
          }
          const status = result.error.includes("not found") ? 404 : 500;
          return c.json({ ok: false, error: result.error }, status);
        }
        return c.json({ ok: true, livePath: result.livePath }, 200);
      } catch (error) {
        return c.json({ ok: false, error: stringifyError(error) }, 500);
      }
    },
  )
  // ─── DRAFT CRUD ─────────────────────────────────────────────────────────
  // Upsert an entity (agent/signal/job/memory-own/memory-mount) into the draft config
  .post(
    "/:workspaceId/draft/items/:kind",
    zValidator(
      "param",
      z.object({
        workspaceId: z.string().min(1),
        kind: z.enum(["agent", "signal", "job", "memory-own", "memory-mount"] as const),
      }),
    ),
    zValidator(
      "json",
      z.object({ id: z.string().min(1), config: z.record(z.string(), z.unknown()) }),
    ),
    async (c) => {
      const { workspaceId, kind } = c.req.valid("param");
      const { id, config } = c.req.valid("json");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const result =
          kind === "memory-own" || kind === "memory-mount"
            ? await upsertDraftMemoryEntry(workspace.path, kind as MemoryItemKind, id, config)
            : await upsertDraftItem(workspace.path, kind as DraftItemKind, id, config);
        if (!result.ok) {
          if (result.error === "No draft exists") {
            return c.json({ ok: false, error: result.error }, 409);
          }
          return c.json({ ok: false, error: result.error }, 400);
        }
        return c.json(
          {
            ok: result.value.ok,
            diff: result.value.diff,
            structural_issues: result.value.structuralIssues,
          },
          200,
        );
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  // Delete an entity (agent/signal/job) from the draft config
  .delete(
    "/:workspaceId/draft/items/:kind/:id",
    zValidator(
      "param",
      z.object({
        workspaceId: z.string().min(1),
        kind: z.enum(["agent", "signal", "job"] as const),
        id: z.string().min(1),
      }),
    ),
    async (c) => {
      const { workspaceId, kind, id } = c.req.valid("param");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const result = await deleteDraftItem(workspace.path, kind as DraftItemKind, id);
        if (!result.ok) {
          if (result.error.includes("not found in draft")) {
            return c.json({ success: false, error: result.error }, 404);
          }
          return c.json({ success: false, error: result.error }, 409);
        }
        const structuralIssues =
          result.value.report.status === "error" ? result.value.report.errors : null;
        return c.json(
          {
            ok: true,
            diff: { removed: [{ path: `${kind}s.${id}`, oldValue: result.value.oldValue }] },
            structural_issues: structuralIssues,
          },
          200,
        );
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  // Validate the current draft config
  .post(
    "/:workspaceId/draft/validate",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const draftResult = await readDraft(workspace.path);
        let registry: Registry | undefined;
        if (draftResult.ok) {
          registry = await buildMcpToolRegistry(draftResult.value);
        }
        const result = await validateDraft(workspace.path, registry);
        if (!result.ok) {
          return c.json({ success: false, error: result.error }, 409);
        }
        return c.json({ success: true, report: result.value }, 200);
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  // Discard draft via DELETE
  .delete(
    "/:workspaceId/draft",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        const result = await discardDraft(workspace.path);
        if (!result.ok) {
          return c.json({ success: false, error: result.error }, 409);
        }
        return c.json({ success: true }, 200);
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  );

export { workspacesRoutes };
export type WorkspaceRoutes = typeof workspacesRoutes;
