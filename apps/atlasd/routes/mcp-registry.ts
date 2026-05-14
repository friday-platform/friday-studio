import process from "node:process";
import type { LinkCredentialRef, MCPServerConfig } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { getAnnotation, isOfficialCanonicalName } from "@atlas/core/mcp-registry/annotations";
import { buildBearerAuthConfig } from "@atlas/core/mcp-registry/auth-config";
import { discoverMCPServers, type LinkSummary } from "@atlas/core/mcp-registry/discovery";
import { runDoctor } from "@atlas/core/mcp-registry/doctor";
import { fetchReadme } from "@atlas/core/mcp-registry/readme-fetcher";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import {
  type DoctorReport,
  type MCPServerMetadata,
  MCPServerMetadataSchema,
} from "@atlas/core/mcp-registry/schemas";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import {
  type DynamicApiKeyProviderInput,
  type DynamicOAuthProviderInput,
  translate,
} from "@atlas/core/mcp-registry/translator";
import {
  MCPUpstreamClient,
  type UpstreamServerEntry,
} from "@atlas/core/mcp-registry/upstream-client";
import type { PlatformModels } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { zValidator } from "@hono/zod-validator";
import { stepCountIs, streamText } from "ai";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { sseResponse } from "../src/lib/sse.ts";
import { requireWorkspaceMember } from "../src/workspace-authz.ts";
import {
  classifyProbeError,
  getCachedTools,
  getInFlightPrewarm,
  getRaceCapMs,
  invalidateCache,
  prewarmTools,
  probeAndExtract,
  putCachedTools,
} from "./mcp-tool-cache.ts";

const logger = createLogger({ name: "mcp-registry-routes" });

/**
 * Derive a kebab-case ID from a display name.
 */
function deriveId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/**
 * Best-effort creation of a Link provider.
 * Returns undefined on success, a warning string on failure.
 */
async function createLinkProvider(
  provider: DynamicApiKeyProviderInput | DynamicOAuthProviderInput,
): Promise<string | undefined> {
  // Same resolution order as the link proxy in routes/link.ts —
  // explicit LINK_SERVICE_URL beats FRIDAY_PORT_LINK fallback beats
  // the legacy :3100 default. Keeps desktop port-override installs
  // talking to the right link binary. Scheme follows the s2s mesh
  // (https when FRIDAY_TLS_CERT/_KEY set, http fallback otherwise).
  const linkScheme = process.env.FRIDAY_TLS_CERT && process.env.FRIDAY_TLS_KEY ? "https" : "http";
  const linkServiceUrl =
    process.env.LINK_SERVICE_URL ??
    (process.env.FRIDAY_PORT_LINK
      ? `${linkScheme}://localhost:${process.env.FRIDAY_PORT_LINK}`
      : `${linkScheme}://localhost:3100`);
  const url = `${linkServiceUrl}/v1/providers`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const atlasKey = process.env.FRIDAY_KEY;
  if (atlasKey) {
    headers.Authorization = `Bearer ${atlasKey}`;
  }

  try {
    const linkRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider }),
    });

    if (linkRes.status === 409) {
      logger.debug("link provider already exists", { providerId: provider.id });
      return undefined;
    }
    if (!linkRes.ok) {
      const body = await linkRes.text().catch(() => "");
      logger.warn("link provider creation failed", {
        status: linkRes.status,
        providerId: provider.id,
        body,
      });
      return `Link provider creation failed: ${linkRes.status}`;
    }
    return undefined;
  } catch (error) {
    logger.warn("link provider creation request failed", { error, providerId: provider.id });
    return "Link provider creation failed: network error";
  }
}

/**
 * Schema for creating new MCP registry entries.
 * Extends MCPServerMetadataSchema with stricter validation for user input:
 * - id: lowercase alphanumeric with dashes, max 64 chars
 * - name: 1-100 chars
 * - source: excludes "static" (reserved for blessed registry)
 *
 * Breaking change (improve-agent-selection): `domains` field removed from
 * MCPServerMetadataSchema. Use `urlDomains` for URL-to-server mapping.
 * Zod v4 strips unknown keys silently — clients sending `domains` won't error
 * but the field is ignored. Web client verified clean (no `domains` usage).
 */
const CreateEntrySchema = z.object({
  entry: MCPServerMetadataSchema.extend({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/)
      .max(64),
    name: z.string().min(1).max(100),
    source: z.enum(["web", "agents"]), // "static" reserved for blessed registry
  }),
});

/**
 * Schema for install request from registry.
 */
const InstallRequestSchema = z.object({ registryName: z.string().min(1) });

/**
 * Schema for search query parameters.
 */
const SearchQuerySchema = z.object({
  q: z.string().default(""),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Schema for custom server addition request.
 */
const AddCustomServerRequestSchema = z
  .object({
    name: z.string().min(1).max(100),
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(64)
      .optional(),
    description: z.string().max(500).optional(),
    httpUrl: z.string().url().optional(),
    configJson: z
      .object({
        transport: z.union([
          z.object({
            type: z.literal("stdio"),
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
          }),
          z.object({ type: z.literal("http"), url: z.string().url() }),
        ]),
        envVars: z
          .array(
            z.object({
              key: z.string().min(1).max(128),
              description: z.string().max(200).optional(),
              exampleValue: z.string().optional(),
            }),
          )
          .default([]),
      })
      .optional(),
  })
  .refine((data) => (data.httpUrl ? !data.configJson : !!data.configJson), {
    message: "Provide either httpUrl or configJson, not both.",
  });

/**
 * Create upstream client (can be mocked for tests).
 */
function createUpstreamClient(): MCPUpstreamClient {
  return new MCPUpstreamClient();
}

/** README size cap — keeps the entry under Deno KV's 64 KB atomic-write limit. */
const MAX_README_BYTES = 30_000;

function truncateReadme(readme: string): string {
  return readme.length > MAX_README_BYTES
    ? `${readme.slice(0, MAX_README_BYTES)}\n\n[README truncated for storage]`
    : readme;
}

/**
 * Derive a GitHub repo URL from an `io.github.OWNER/REPO` canonical name. Many
 * registry entries omit the `repository` field, but the canonical name encodes
 * the repo for GitHub-hosted servers — enough to still fetch the README.
 */
function githubUrlFromCanonicalName(canonicalName: string): string | undefined {
  const match = canonicalName.match(/^io\.github\.([^/]+)\/(.+)$/);
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

/**
 * Whether the translator can actually install this upstream entry. An allowlist
 * of the transports the translator supports — npm/PyPI stdio packages, or a
 * streamable-http remote — so search never surfaces a server (OCI, SSE-only,
 * etc.) that would dead-end on a "not supported" error at install.
 */
function isInstallableEntry(entry: UpstreamServerEntry): boolean {
  const { server } = entry;
  const hasStdioPackage = (server.packages ?? []).some(
    (p) => (p.registryType === "npm" || p.registryType === "pypi") && p.transport.type === "stdio",
  );
  const hasHttpRemote = (server.remotes ?? []).some((r) => r.type === "streamable-http");
  return hasStdioPackage || hasHttpRemote;
}

/** Shared `:id` path-param schema for registry server routes. */
const IdParamSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(64),
});

/** Body for `POST /install/commit/:id` — the user-confirmed env var list. */
const CommitSchema = z.object({
  env_vars: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        isRequired: z.boolean(),
        isSecret: z.boolean(),
        default: z.string().optional(),
      }),
    )
    .min(1),
});

/** Body for `POST /manual-config/:id` — credentials vs. plain settings, split by the user. */
const ManualConfigSchema = z.object({
  credentials: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        isRequired: z.boolean(),
      }),
    )
    .default([]),
  settings: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        default: z.string().optional(),
      }),
    )
    .default([]),
});

/** A typed event in a doctor's background run, streamed to detail-page subscribers. */
type DoctorProgressEvent =
  | { type: "phase"; phase: "fetching-readme" | "prompting-llm" | "validating" }
  | { type: "result"; report: DoctorReport };

/**
 * In-process pub/sub bridging a doctor's background task to its SSE stream.
 * Every event is buffered and replayed in full to each new subscriber, so a
 * client that joins partway through the run still sees the whole sequence
 * (phase events aren't re-sent live). A subscriber that joins after the
 * channel is dropped replays from the persisted entry instead.
 */
const doctorProgress = (() => {
  interface Channel {
    listeners: Set<(e: DoctorProgressEvent) => void>;
    buffer: DoctorProgressEvent[];
    done: boolean;
  }
  const channels = new Map<string, Channel>();
  function channelFor(serverId: string): Channel {
    let ch = channels.get(serverId);
    if (!ch) {
      ch = { listeners: new Set(), buffer: [], done: false };
      channels.set(serverId, ch);
    }
    return ch;
  }
  return {
    emit(serverId: string, event: DoctorProgressEvent): void {
      const ch = channelFor(serverId);
      ch.buffer.push(event);
      for (const listener of ch.listeners) listener(event);
      if (event.type === "result") {
        ch.done = true;
        ch.listeners.clear();
        // The persisted entry is the source of truth for any later reload —
        // drop the channel shortly after the terminal event.
        setTimeout(() => channels.delete(serverId), 30_000);
      }
    },
    subscribe(serverId: string, listener: (e: DoctorProgressEvent) => void): () => void {
      const ch = channelFor(serverId);
      // Replay everything emitted so far, then follow live events if the run
      // hasn't already finished.
      for (const event of ch.buffer) listener(event);
      if (!ch.done) ch.listeners.add(listener);
      return () => {
        ch.listeners.delete(listener);
      };
    },
  };
})();

/** In-flight doctor background tasks, tracked so tests can await them. */
const inFlightDoctorTasks = new Set<Promise<void>>();

/** Test seam — await all in-flight doctor background tasks. */
export async function _flushDoctorTasksForTest(): Promise<void> {
  await Promise.allSettled(Array.from(inFlightDoctorTasks));
}

/**
 * Run the doctor for an undeclared-env install, off the request path. Emits
 * phase events to the progress hub, persists the terminal status + report,
 * then emits the result. Never throws — a failure persists `ready` with an
 * `unknown` report, matching the in-process `runDoctor` contract.
 */
function runDoctorInBackground(
  serverId: string,
  upstreamEntry: UpstreamServerEntry,
  platformModels: PlatformModels,
): void {
  const task = (async () => {
    try {
      doctorProgress.emit(serverId, { type: "phase", phase: "fetching-readme" });
      const repoUrl =
        upstreamEntry.server.repository?.url ??
        githubUrlFromCanonicalName(upstreamEntry.server.name);
      const subfolder = upstreamEntry.server.repository?.subfolder;
      let readme: string | null = null;
      if (repoUrl) {
        try {
          readme = await fetchReadme(repoUrl, subfolder);
        } catch {
          logger.debug("doctor readme fetch failed, continuing without", { serverId, repoUrl });
        }
      }
      const adapter = await getMCPRegistryAdapter();
      if (readme) await adapter.update(serverId, { readme: truncateReadme(readme) });

      doctorProgress.emit(serverId, { type: "phase", phase: "prompting-llm" });
      const report = await runDoctor({ registryEntry: upstreamEntry, readme, platformModels });

      doctorProgress.emit(serverId, { type: "phase", phase: "validating" });
      const status = report.verdict === "attention" ? "awaiting_confirm" : "ready";
      await adapter.update(serverId, { status, doctor_report: report });

      doctorProgress.emit(serverId, { type: "result", report });
    } catch (error) {
      // runDoctor itself never throws, but the README fetch or adapter writes
      // can. Collapse to the same terminal contract.
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("doctor background task failed", { serverId, error: detail });
      const report: DoctorReport = {
        verdict: "unknown",
        tldr: "The setup doctor could not complete.",
        findings: [{ severity: "error", title: "Doctor task failed", detail }],
      };
      try {
        const adapter = await getMCPRegistryAdapter();
        await adapter.update(serverId, { status: "ready", doctor_report: report });
      } catch (persistError) {
        logger.error("doctor background task could not persist failure", {
          serverId,
          error: persistError,
        });
      }
      doctorProgress.emit(serverId, { type: "result", report });
    }
  })();
  inFlightDoctorTasks.add(task);
  void task.finally(() => inFlightDoctorTasks.delete(task));
}

export const mcpRegistryRouter = daemonFactory
  .createApp()
  .post("/", zValidator("json", CreateEntrySchema), async (c) => {
    const { entry } = c.req.valid("json");
    const adapter = await getMCPRegistryAdapter();

    // Check blessed first - these are static and can't be overwritten
    if (mcpServersRegistry.servers[entry.id]) {
      return c.json(
        { error: `Server "${entry.id}" exists in blessed registry. Use it instead.` },
        409,
      );
    }

    // Atomic add - throws if entry already exists
    try {
      await adapter.add(entry);
      prewarmTools(entry.id, entry.configTemplate, logger);
      return c.json({ server: entry }, 201);
    } catch {
      const suggested = `${entry.id}-${Date.now().toString(36).slice(-4)}`;
      return c.json({ error: `Server ID "${entry.id}" already used.`, suggestion: suggested }, 409);
    }
  })
  .get("/", async (c) => {
    const adapter = await getMCPRegistryAdapter();
    const dynamicServers = await adapter.list();
    const staticServers = Object.values(mcpServersRegistry.servers);

    const staticIds = new Set(staticServers.map((s) => s.id));
    const uniqueDynamic = dynamicServers.filter((s) => !staticIds.has(s.id));

    return c.json({
      servers: [...staticServers, ...uniqueDynamic],
      metadata: {
        version: mcpServersRegistry.metadata.version,
        staticCount: staticServers.length,
        dynamicCount: uniqueDynamic.length,
      },
    });
  })
  .get("/search", zValidator("query", SearchQuerySchema), async (c) => {
    const { q, limit } = c.req.valid("query");
    const client = createUpstreamClient();
    const adapter = await getMCPRegistryAdapter();

    try {
      const searchResult = await client.search(q, limit, "latest");
      const dynamicServers = await adapter.list();

      // Build set of installed canonical names for quick lookup
      const installedCanonicalNames = new Set(
        dynamicServers
          .filter((s) => s.upstream?.canonicalName)
          .map((s) => s.upstream?.canonicalName),
      );

      // Only surface servers the translator can actually install.
      const servers = searchResult.servers.filter(isInstallableEntry).map((entry) => {
        const annotation = getAnnotation(entry.server.name);
        return {
          name: entry.server.name,
          displayName: annotation?.displayName,
          description: entry.server.description,
          vendor: entry.server.name.split("/")[0] ?? entry.server.name,
          version: entry.server.version,
          updatedAt: entry._meta["io.modelcontextprotocol.registry/official"].updatedAt,
          alreadyInstalled: installedCanonicalNames.has(entry.server.name),
          isOfficial: isOfficialCanonicalName(entry.server.name),
          repositoryUrl: entry.server.repository?.url ?? null,
        };
      });

      return c.json({ servers });
    } catch (error) {
      logger.error("upstream search failed", { error, q, limit });
      return c.json({ error: "Search failed" }, 502);
    }
  })
  .post("/install/preflight", zValidator("json", InstallRequestSchema), async (c) => {
    const { registryName } = c.req.valid("json");
    const client = createUpstreamClient();
    const adapter = await getMCPRegistryAdapter();

    let upstreamEntry: UpstreamServerEntry;
    try {
      upstreamEntry = await client.fetchLatest(registryName);
    } catch (error) {
      logger.error("preflight fetch failed", { error, registryName });
      if (error instanceof Error && error.message.includes("not found")) {
        return c.json({ error: `Server "${registryName}" not found in registry.` }, 404);
      }
      return c.json({ error: "Install failed" }, 502);
    }

    const translateResult = translate(upstreamEntry);
    if (!translateResult.success) {
      return c.json({ error: translateResult.reason }, 400);
    }
    const entry = translateResult.entry;

    // Collision checks — blessed, dynamic-by-id, dynamic-by-canonical.
    if (mcpServersRegistry.servers[entry.id]) {
      return c.json(
        { error: `Server ID "${entry.id}" collides with blessed registry entry "${entry.id}".` },
        409,
      );
    }
    if (await adapter.get(entry.id)) {
      return c.json(
        {
          error: `Server "${entry.id}" (canonical: "${entry.upstream?.canonicalName}") is already installed from registry.`,
          existingId: entry.id,
        },
        409,
      );
    }
    const dynamicServers = await adapter.list();
    const existingByCanonical = dynamicServers.find(
      (s) => s.upstream?.canonicalName === entry.upstream?.canonicalName,
    );
    if (existingByCanonical) {
      return c.json(
        {
          error: `Server with canonical name "${entry.upstream?.canonicalName}" is already installed as "${existingByCanonical.id}".`,
          existingId: existingByCanonical.id,
        },
        409,
      );
    }

    // Fast path vs. doctor path. The doctor only runs for a *bare* entry — one
    // where the registry declared no env vars and translation synthesized no
    // Link provider either (e.g. an HTTP-remote OAuth server). When the
    // registry told us what the server needs, or translation did, install
    // finishes inline with no LLM call.
    const hasDeclaredEnvs =
      upstreamEntry.server.packages?.some((p) => (p.environmentVariables?.length ?? 0) > 0) ??
      false;
    const needsDoctor = !hasDeclaredEnvs && !translateResult.linkProvider;

    if (!needsDoctor) {
      // Fast path — no LLM call. Fetch the README synchronously, persist ready.
      const repoUrl =
        upstreamEntry.server.repository?.url ??
        githubUrlFromCanonicalName(upstreamEntry.server.name);
      const subfolder = upstreamEntry.server.repository?.subfolder;
      if (repoUrl) {
        try {
          const readme = await fetchReadme(repoUrl, subfolder);
          if (readme) entry.readme = truncateReadme(readme);
        } catch {
          logger.debug("readme fetch failed, continuing without", { registryName, repoUrl });
        }
      }
      entry.status = "ready";
      await adapter.add(entry);
      prewarmTools(entry.id, entry.configTemplate, logger);

      let warning: string | undefined;
      if (translateResult.linkProvider) {
        warning = await createLinkProvider(translateResult.linkProvider);
      }
      return c.json(
        { server_id: entry.id, status: "ready" as const, ...(warning ? { warning } : {}) },
        201,
      );
    }

    // Doctor path — persist `setting_up`, run the doctor off the request path.
    entry.status = "setting_up";
    await adapter.add(entry);
    const ctx = c.get("app");
    runDoctorInBackground(entry.id, upstreamEntry, ctx.platformModels);
    return c.json({ server_id: entry.id, status: "setting_up" as const }, 201);
  })
  .post(
    "/install/commit/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", CommitSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { env_vars } = c.req.valid("json");
      const adapter = await getMCPRegistryAdapter();

      const entry = await adapter.get(id);
      if (!entry) {
        return c.json({ error: "Server not found" }, 404);
      }
      if (entry.status !== "awaiting_confirm") {
        return c.json(
          {
            error: `Server "${id}" is not awaiting confirmation (status: ${entry.status ?? "ready"}).`,
          },
          409,
        );
      }
      if (!entry.upstream?.canonicalName) {
        return c.json({ error: "Server has no upstream provenance." }, 400);
      }

      // Re-fetch upstream and translate with the user-confirmed env vars — the
      // commit checkpoint is the only safe window to build the write-once Link
      // provider schema.
      const client = createUpstreamClient();
      let upstreamEntry: UpstreamServerEntry;
      try {
        upstreamEntry = await client.fetchLatest(entry.upstream.canonicalName);
      } catch (error) {
        logger.error("commit fetch failed", { error, id });
        return c.json({ error: "Commit failed: could not re-fetch the registry entry." }, 502);
      }

      const translateResult = translate(upstreamEntry, { extraEnvVars: env_vars });
      if (!translateResult.success) {
        return c.json({ error: translateResult.reason }, 400);
      }

      let warning: string | undefined;
      if (translateResult.linkProvider) {
        warning = await createLinkProvider(translateResult.linkProvider);
      }

      const updated = await adapter.update(id, {
        configTemplate: translateResult.entry.configTemplate,
        status: "ready",
        ...(translateResult.entry.requiredConfig
          ? { requiredConfig: translateResult.entry.requiredConfig }
          : {}),
      });
      if (!updated) {
        return c.json({ error: "Server was modified concurrently." }, 409);
      }

      invalidateCache(id);
      prewarmTools(id, updated.configTemplate, logger);
      return c.json(
        { server_id: id, status: "ready" as const, ...(warning ? { warning } : {}) },
        200,
      );
    },
  )
  .post("/install/cancel/:id", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    if (mcpServersRegistry.servers[id]) {
      return c.json({ error: `Built-in server "${id}" cannot be cancelled.` }, 403);
    }
    const adapter = await getMCPRegistryAdapter();
    if (!(await adapter.get(id))) {
      return c.json({ error: "Server not found" }, 404);
    }
    await adapter.delete(id);
    invalidateCache(id);
    return new Response(null, { status: 204 });
  })
  .post(
    "/manual-config/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", ManualConfigSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { credentials, settings } = c.req.valid("json");
      const adapter = await getMCPRegistryAdapter();

      const entry = await adapter.get(id);
      if (!entry) {
        return c.json({ error: "Server not found" }, 404);
      }
      // The doctor must have finished, and an `attention` entry's Link provider
      // is frozen — additive schema changes there need uninstall + re-add.
      if (entry.status === "setting_up") {
        return c.json({ error: "Server is still being analyzed." }, 409);
      }
      if (entry.doctor_report?.verdict === "attention") {
        return c.json({ error: "link_provider_frozen" }, 409);
      }

      // Credentials → Link provider fields + Link refs; settings → plain strings.
      const env: Record<string, string | LinkCredentialRef> = {
        ...(entry.configTemplate.env ?? {}),
      };
      const requiredConfig = [...(entry.requiredConfig ?? [])];
      const secretSchema: Record<string, "string"> = {};
      for (const cred of credentials) {
        env[cred.name] = { from: "link", provider: id, key: cred.name };
        secretSchema[cred.name] = "string";
        if (cred.isRequired) {
          requiredConfig.push({
            key: cred.name,
            description: cred.description ?? cred.name,
            type: "string",
          });
        }
      }
      for (const setting of settings) {
        env[setting.name] = setting.default ?? "";
      }

      let warning: string | undefined;
      if (credentials.length > 0) {
        warning = await createLinkProvider({
          type: "apikey",
          id,
          displayName: entry.name,
          description: entry.description ?? entry.name,
          secretSchema,
        });
      }

      const updated = await adapter.update(id, {
        configTemplate: { ...entry.configTemplate, env },
        ...(requiredConfig.length > 0 ? { requiredConfig } : {}),
      });
      if (!updated) {
        return c.json({ error: "Server was modified concurrently." }, 409);
      }

      invalidateCache(id);
      prewarmTools(id, updated.configTemplate, logger);
      return c.json({ server_id: id, ...(warning ? { warning } : {}) }, 200);
    },
  )
  .post("/custom", zValidator("json", AddCustomServerRequestSchema), async (c) => {
    const body = c.req.valid("json");
    const adapter = await getMCPRegistryAdapter();

    let id = "";

    if (body.id) {
      // Explicit ID: immediate collision checks, no auto-retry
      id = body.id;
      if (mcpServersRegistry.servers[id]) {
        return c.json({ error: `Server ID "${id}" collides with blessed registry entry.` }, 409);
      }
      const existingDynamic = await adapter.get(id);
      if (existingDynamic) {
        return c.json({ error: `Server ID "${id}" already used.` }, 409);
      }
    } else {
      // Derive ID from name; retry once with timestamp suffix on dynamic collision
      const derivedId = deriveId(body.name);
      const tryIds = [derivedId, `${derivedId}-${Date.now().toString(36).slice(-4)}`];
      let resolved = false;
      for (const candidateId of tryIds) {
        if (mcpServersRegistry.servers[candidateId]) {
          continue; // blessed collision — try suffix
        }
        const existingDynamic = await adapter.get(candidateId);
        if (existingDynamic) {
          continue; // dynamic collision — try suffix
        }
        id = candidateId;
        resolved = true;
        break;
      }
      if (!resolved) {
        return c.json({ error: `Server ID "${tryIds[tryIds.length - 1]}" already used.` }, 409);
      }
    }

    // Build MCPServerMetadata
    const requiredConfig: Array<{
      key: string;
      description: string;
      type: "string" | "array" | "object" | "number";
      examples?: string[];
    }> = [];
    let linkProvider: DynamicApiKeyProviderInput | DynamicOAuthProviderInput | undefined;

    let configTemplate: MCPServerConfig;

    if (body.httpUrl) {
      const { auth, env, requiredConfig: bearerRequiredConfig } = buildBearerAuthConfig(id, id);
      configTemplate = { transport: { type: "http", url: body.httpUrl }, auth, env };
      requiredConfig.push(...bearerRequiredConfig);
      linkProvider = {
        type: "oauth",
        id,
        displayName: body.name,
        description: body.description ?? `OAuth provider for ${body.name}`,
        oauthConfig: { mode: "discovery", serverUrl: body.httpUrl },
      };
    } else if (body.configJson) {
      const { transport, envVars } = body.configJson;
      configTemplate = {
        transport,
        ...(transport.type === "stdio" ? { skipResolverCheck: true as const } : {}),
      };

      if (envVars.length > 0) {
        const env: Record<string, string | LinkCredentialRef> = {};
        const secretSchema: Record<string, "string"> = {};
        for (const ev of envVars) {
          env[ev.key] = { from: "link", provider: id, key: ev.key };
          secretSchema[ev.key] = "string";
          requiredConfig.push({
            key: ev.key,
            description: ev.description ?? `Credential: ${ev.key}`,
            type: "string",
            examples: ev.exampleValue ? [ev.exampleValue] : undefined,
          });
        }
        configTemplate = { ...configTemplate, env };
        linkProvider = {
          type: "apikey",
          id,
          displayName: body.name,
          description: body.description ?? `API key provider for ${body.name}`,
          secretSchema,
        };
      }
    } else {
      // This branch is unreachable because Zod refine ensures one path is present,
      // but TypeScript needs the explicit exhaustiveness.
      return c.json({ error: "Provide either httpUrl or configJson." }, 400);
    }

    const entry = {
      id,
      name: body.name,
      description: body.description,
      securityRating: "unverified" as const,
      source: "web" as const,
      configTemplate,
      requiredConfig: requiredConfig.length > 0 ? requiredConfig : undefined,
    };

    await adapter.add(entry);
    prewarmTools(entry.id, entry.configTemplate, logger);

    let warning: string | undefined;
    if (linkProvider) {
      warning = await createLinkProvider(linkProvider);
    }

    const response = warning ? { server: entry, warning } : { server: entry };
    return c.json(response, 201);
  })
  .get(
    "/:id/check-update",
    zValidator(
      "param",
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(64),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");
      const adapter = await getMCPRegistryAdapter();

      // Get stored entry
      const storedEntry = await adapter.get(id);
      if (!storedEntry) {
        return c.json({ error: "Server not found" }, 404);
      }

      // Check if it has upstream provenance
      if (!storedEntry.upstream?.canonicalName) {
        return c.json({ hasUpdate: false, reason: "Server was not installed from registry." }, 200);
      }

      const client = createUpstreamClient();

      try {
        // Fetch latest from upstream
        const upstreamEntry = await client.fetchLatest(storedEntry.upstream.canonicalName);
        const remoteUpdatedAt =
          upstreamEntry._meta["io.modelcontextprotocol.registry/official"].updatedAt;
        const storedUpdatedAt = storedEntry.upstream.updatedAt;

        const remoteTime = Date.parse(remoteUpdatedAt);
        const storedTime = Date.parse(storedUpdatedAt);

        if (Number.isNaN(remoteTime) || Number.isNaN(storedTime)) {
          return c.json({ hasUpdate: false, reason: "Unable to compare version timestamps." }, 200);
        }

        if (remoteTime > storedTime) {
          return c.json({
            hasUpdate: true,
            remote: { updatedAt: remoteUpdatedAt, version: upstreamEntry.server.version },
          });
        }

        return c.json({ hasUpdate: false, reason: "Server is up to date." });
      } catch (error) {
        logger.error("check-update failed", { error, id });
        return c.json({ hasUpdate: false, reason: "Failed to check for updates." }, 200);
      }
    },
  )
  .post(
    "/:id/update",
    zValidator(
      "param",
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(64),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");
      const adapter = await getMCPRegistryAdapter();

      // Get stored entry
      const storedEntry = await adapter.get(id);
      if (!storedEntry) {
        return c.json({ error: "Server not found" }, 404);
      }

      // Check if it has upstream provenance
      if (!storedEntry.upstream?.canonicalName) {
        return c.json({ error: "Server was not installed from registry." }, 400);
      }

      const client = createUpstreamClient();

      try {
        // Fetch latest from upstream
        const upstreamEntry = await client.fetchLatest(storedEntry.upstream.canonicalName);

        // Re-translate
        const translateResult = translate(upstreamEntry);
        if (!translateResult.success) {
          return c.json({ error: `Translation failed: ${translateResult.reason}` }, 400);
        }

        // Preserve the stored ID (don't let re-translation change it)
        // Update all fields except id and source per adapter contract
        const { id: _newId, source: _newSource, ...updatableFields } = translateResult.entry;

        // Re-fetch README on update (best-effort)
        const repoUrl = upstreamEntry.server.repository?.url;
        const subfolder = upstreamEntry.server.repository?.subfolder;
        if (repoUrl) {
          try {
            const readme = await fetchReadme(repoUrl, subfolder);
            if (readme) {
              (updatableFields as Record<string, unknown>).readme = readme;
            }
          } catch {
            logger.debug("readme re-fetch failed on update, keeping existing", { id, repoUrl });
          }
        }

        const updatedEntry = await adapter.update(storedEntry.id, updatableFields);
        if (!updatedEntry) {
          return c.json({ error: "Server was modified concurrently." }, 409);
        }

        invalidateCache(updatedEntry.id);
        prewarmTools(updatedEntry.id, updatedEntry.configTemplate, logger);

        return c.json({ server: updatedEntry });
      } catch (error) {
        logger.error("pull-update failed", { error, id });
        return c.json({ error: "Update failed" }, 502);
      }
    },
  )
  .delete(
    "/:id",
    zValidator(
      "param",
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(64),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");

      // Static entries cannot be deleted
      if (mcpServersRegistry.servers[id]) {
        return c.json({ error: `Built-in server "${id}" cannot be deleted.` }, 403);
      }

      const adapter = await getMCPRegistryAdapter();
      const dynamicServer = await adapter.get(id);
      if (!dynamicServer) {
        return c.json({ error: "Server not found" }, 404);
      }

      await adapter.delete(id);
      // Deliberate leak window: an in-flight prewarm started moments before
      // this DELETE will eventually `putCachedTools` *after* this
      // `invalidateCache(id)`, leaving a stale entry until TTL eviction or
      // process restart. Re-add with the same config hits the stale entry
      // (correct tools); re-add with different config sees configHash
      // mismatch and re-probes. Not worth wiring an AbortController through
      // prewarm.
      invalidateCache(id);
      return new Response(null, { status: 204 });
    },
  )
  .get(
    "/:id/tools",
    zValidator(
      "param",
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(64),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");

      let server: MCPServerMetadata | undefined = mcpServersRegistry.servers[id];
      if (!server) {
        const adapter = await getMCPRegistryAdapter();
        server = (await adapter.get(id)) ?? undefined;
      }

      if (!server) {
        return c.json({ error: "Server not found" }, 404);
      }

      const cached = getCachedTools(id, server.configTemplate);
      if (cached) {
        return c.json({ ok: true as const, tools: cached });
      }

      // If a prewarm is already in flight (just-added server, cold install
      // still downloading), wait for it instead of spawning a duplicate
      // npx/uvx process. Race-cap the wait at 5s — if the cold install runs
      // longer, return a retryable hint rather than block for the prewarm's
      // full 60s budget.
      const inFlight = getInFlightPrewarm(id, server.configTemplate);
      if (inFlight) {
        const TIMED_OUT = Symbol("timeout");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timed = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), getRaceCapMs());
        });
        const winner = await Promise.race([inFlight, timed]);
        if (timer) clearTimeout(timer);

        if (winner === TIMED_OUT) {
          return c.json({
            ok: false as const,
            retryable: true as const,
            error: "MCP server is still starting up. Retry in a few seconds.",
          });
        }
        if (winner.ok) {
          return c.json({ ok: true as const, tools: winner.tools });
        }
        // Prewarm finished with a classified error (DNS, auth, etc.) — surface
        // it directly instead of forcing the user to retry into the foreground
        // probe just to learn what went wrong.
        logger.warn("MCP tool probe failed", {
          serverId: id,
          phase: winner.phase,
          error: winner.error,
        });
        return c.json({ ok: false as const, error: winner.error, phase: winner.phase });
      }

      try {
        const tools = await probeAndExtract(id, server.configTemplate, logger, 5000);
        putCachedTools(id, server.configTemplate, tools);
        return c.json({ ok: true as const, tools });
      } catch (error) {
        const classified = classifyProbeError(error);
        logger.warn("MCP tool probe failed", {
          serverId: id,
          phase: classified.phase,
          error: classified.error,
        });
        return c.json({ ok: false as const, error: classified.error, phase: classified.phase });
      }
    },
  )
  .post(
    "/:id/test-chat",
    zValidator(
      "param",
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(64),
      }),
    ),
    zValidator("query", z.object({ workspaceId: z.string().optional() })),
    zValidator("json", z.object({ message: z.string().min(1) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { workspaceId } = c.req.valid("query");
      const { message } = c.req.valid("json");

      if (workspaceId) {
        await requireWorkspaceMember(c, workspaceId);
      }

      let server: MCPServerMetadata | undefined = mcpServersRegistry.servers[id];
      if (!server) {
        const adapter = await getMCPRegistryAdapter();
        server = (await adapter.get(id)) ?? undefined;
      }

      if (!server) {
        return c.json({ error: "Server not found" }, 404);
      }

      let workspaceConfig: import("@atlas/config").WorkspaceConfig | undefined;
      let linkSummary: LinkSummary | undefined;

      if (workspaceId) {
        const ctx = c.get("app");
        const manager = ctx.daemon.getWorkspaceManager();
        const mergedConfig = await manager.getWorkspaceConfig(workspaceId);
        if (!mergedConfig) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        workspaceConfig = mergedConfig.workspace;

        try {
          const result = await parseResult(client.link.v1.summary.$get({ query: {} }));
          if (result.ok && "providers" in result.data) {
            linkSummary = result.data as LinkSummary;
          }
        } catch {
          // Ignore — unconfigured Link-backed servers will fail with auth error later
        }
      }

      const ctx = c.get("app");
      const model = ctx.platformModels.get("conversational");

      const encoder = new TextEncoder();
      let closed = false;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          function enqueue(event: string, data: unknown): void {
            if (closed) return;
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          }

          let mcpResult: Awaited<ReturnType<typeof createMCPTools>> | undefined;

          try {
            let resolvedConfig = server.configTemplate;
            if (workspaceId && workspaceConfig) {
              const candidates = await discoverMCPServers(
                workspaceId,
                workspaceConfig,
                linkSummary,
              );
              const candidate = candidates.find((c) => c.metadata.id === id);
              if (candidate) {
                resolvedConfig = candidate.mergedConfig;
              }
            }

            mcpResult = await createMCPTools({ [id]: resolvedConfig }, logger, {
              signal: AbortSignal.timeout(30000),
            });

            const result = streamText({
              model,
              system: `You have access to ${server.name} via MCP tools. Answer the user's question using the available tools.`,
              messages: [{ role: "user", content: message }],
              tools: mcpResult.tools,
              stopWhen: [stepCountIs(5)],
              abortSignal: AbortSignal.timeout(60000),
            });

            for await (const chunk of result.fullStream) {
              if (chunk.type === "text-delta") {
                const text = (chunk as unknown as Record<string, string>).delta ?? "";
                enqueue("chunk", { text });
              } else if (chunk.type === "tool-call") {
                enqueue("tool_call", {
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  input: chunk.input,
                });
              } else if (chunk.type === "tool-result") {
                enqueue("tool_result", { toolCallId: chunk.toolCallId, output: chunk.output });
              }
            }

            enqueue("done", {});
          } catch (error) {
            if (!mcpResult) {
              const classified = classifyProbeError(error);
              logger.warn("MCP test-chat failed", {
                serverId: id,
                phase: classified.phase,
                error: classified.error,
              });
              enqueue("error", { error: classified.error, phase: classified.phase });
            } else {
              const errMsg = error instanceof Error ? error.message : String(error);
              logger.warn("Test chat stream failed", { serverId: id, error: errMsg });
              enqueue("error", { error: errMsg });
            }
          } finally {
            closed = true;
            if (mcpResult) {
              await mcpResult.dispose().catch(() => {});
            }
            controller.close();
          }
        },
        cancel() {
          closed = true;
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
  )
  .get("/:id/stream", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const adapter = await getMCPRegistryAdapter();
    const entry = await adapter.get(id);
    if (!entry) {
      return c.json({ error: "Server not found" }, 404);
    }

    // Already terminal — replay the persisted result for a late subscriber,
    // with no phase events.
    if (entry.status !== "setting_up") {
      return sseResponse((writer) => {
        if (entry.doctor_report) {
          writer.send("result", { type: "result", report: entry.doctor_report });
        }
        writer.close();
      });
    }

    // Live — follow the running doctor through the progress hub.
    return sseResponse(
      (writer, signal) =>
        new Promise<void>((resolve) => {
          let settled = false;
          let unsubscribe = (): void => {};
          function finish(): void {
            if (settled) return;
            settled = true;
            unsubscribe();
            clearTimeout(safety);
            resolve();
          }
          // Safety net — a daemon restart mid-run leaves the entry stuck in
          // `setting_up` with no task left to emit a result; don't hang the
          // client forever.
          const safety = setTimeout(() => {
            writer.send("result", {
              type: "result",
              report: {
                verdict: "unknown",
                tldr: "The setup doctor did not finish.",
                findings: [
                  {
                    severity: "error",
                    title: "Doctor timed out",
                    detail: "No result was produced within the expected window.",
                  },
                ],
              },
            });
            finish();
          }, 90_000);
          unsubscribe = doctorProgress.subscribe(id, (event) => {
            writer.send(event.type, event);
            if (event.type === "result") finish();
          });
          // If `subscribe` synchronously replayed a cached result, `finish`
          // already ran with the no-op unsubscribe — drop the real one now.
          if (settled) unsubscribe();
          signal.addEventListener("abort", finish);
        }),
    );
  })
  .get(
    "/:id",
    zValidator(
      "param",
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(64),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");

      const staticServer = mcpServersRegistry.servers[id];
      if (staticServer) {
        return c.json(staticServer);
      }

      const adapter = await getMCPRegistryAdapter();
      const dynamicServer = await adapter.get(id);
      if (dynamicServer) {
        return c.json(dynamicServer);
      }

      return c.json({ error: "Server not found" }, 404);
    },
  );

export type MCPRegistryRoutes = typeof mcpRegistryRouter;
