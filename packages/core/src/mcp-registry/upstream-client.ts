/**
 * HTTP client for the upstream MCP registry (registry.modelcontextprotocol.io).
 *
 * Provides Zod-validated responses for search and version fetch operations.
 *
 * @module
 */

import { createLogger } from "@atlas/logger";
import { z } from "zod";

const logger = createLogger({ name: "mcp-registry-upstream-client" });

// ─── Zod schemas ─────────────────────────────────────────────────────────────

/**
 * Environment variable definition from upstream registry.
 */
export const UpstreamEnvironmentVariableSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  format: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

export type UpstreamEnvironmentVariable = z.infer<typeof UpstreamEnvironmentVariableSchema>;

/**
 * Package entry from upstream registry.
 *
 * `registryType` is `z.string()` (not an enum) to match the upstream spec at
 * `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`,
 * which documents it as an open-ended string with `npm`/`pypi`/`oci`/`nuget`/`mcpb`
 * as examples. Closed enums here have caused production 502s when the registry
 * adds a new type — the translator already filters by known values.
 */
export const UpstreamPackageSchema = z.object({
  registryType: z.string(),
  identifier: z.string(),
  version: z.string().optional(),
  transport: z.object({ type: z.string() }),
  environmentVariables: z.array(UpstreamEnvironmentVariableSchema).optional(),
});

export type UpstreamPackage = z.infer<typeof UpstreamPackageSchema>;

/**
 * Remote header definition from upstream registry.
 */
export const UpstreamRemoteHeaderSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  value: z.string().optional(),
});

export type UpstreamRemoteHeader = z.infer<typeof UpstreamRemoteHeaderSchema>;

/**
 * Remote variable definition from upstream registry.
 */
export const UpstreamRemoteVariableSchema = z.object({
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  default: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

export type UpstreamRemoteVariable = z.infer<typeof UpstreamRemoteVariableSchema>;

/**
 * Remote entry from upstream registry.
 */
export const UpstreamRemoteSchema = z.object({
  type: z.enum(["streamable-http", "sse"]),
  url: z.string(),
  headers: z.array(UpstreamRemoteHeaderSchema).optional(),
  variables: z.record(z.string(), UpstreamRemoteVariableSchema).optional(),
});

export type UpstreamRemote = z.infer<typeof UpstreamRemoteSchema>;

/**
 * Repository reference from upstream registry.
 */
export const UpstreamRepositorySchema = z.object({
  url: z.string().optional(),
  source: z.string().optional(),
  subfolder: z.string().optional(),
});

export type UpstreamRepository = z.infer<typeof UpstreamRepositorySchema>;

/**
 * Core server entry from upstream registry.
 * This is the shape of /v0.1/servers and /v0.1/servers/{name}/versions/latest responses.
 */
export const UpstreamServerSchema = z.object({
  $schema: z.string(),
  name: z.string(),
  description: z.string().optional(),
  repository: UpstreamRepositorySchema.optional(),
  version: z.string(),
  packages: z.array(UpstreamPackageSchema).optional(),
  remotes: z.array(UpstreamRemoteSchema).optional(),
});

export type UpstreamServer = z.infer<typeof UpstreamServerSchema>;

/**
 * Registry metadata from upstream responses.
 * The real API nests updatedAt under the "official" sub-object.
 */
export const UpstreamMetaSchema = z.object({
  "io.modelcontextprotocol.registry/official": z.object({
    status: z.string(),
    statusChangedAt: z.string(),
    publishedAt: z.string(),
    updatedAt: z.string(),
    isLatest: z.boolean(),
  }),
});

export type UpstreamMeta = z.infer<typeof UpstreamMetaSchema>;

/**
 * Full upstream entry with metadata wrapper.
 * Used for single entry fetch (versions/latest).
 */
export const UpstreamServerEntrySchema = z.object({
  server: UpstreamServerSchema,
  _meta: UpstreamMetaSchema,
});

export type UpstreamServerEntry = z.infer<typeof UpstreamServerEntrySchema>;

/**
 * Outer envelope for the upstream /v0.1/servers search response.
 *
 * Entries are intentionally typed as `unknown` here: `search()` parses each
 * one with `UpstreamServerEntrySchema` individually, so a single malformed
 * entry can't sink the whole response.
 */
const UpstreamSearchEnvelopeSchema = z.object({
  servers: z.array(z.unknown()),
  metadata: z.object({ count: z.number() }).optional(),
});

/**
 * Loose probe used only to extract `server.name` for log context when an
 * entry fails strict parsing.
 */
const NameProbeSchema = z.object({ server: z.object({ name: z.string() }).partial() });

/**
 * Return shape of `search()`. Not a Zod schema — the wire response is parsed
 * via `UpstreamSearchEnvelopeSchema` + per-entry `UpstreamServerEntrySchema`.
 *
 * `dropped` counts entries that failed strict parsing and were skipped, so
 * callers can surface drift signals (metrics, headers, etc.) without parsing
 * logs.
 */
export interface UpstreamSearchResponse {
  servers: UpstreamServerEntry[];
  dropped: number;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface MCPUpstreamClientOptions {
  baseUrl?: string;
  /** Optional override for testing — defaults to global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * HTTP client for the upstream MCP registry.
 *
 * Provides Zod-validated access to:
 * - Search: /v0.1/servers?search={query}&limit={limit}
 * - Fetch latest: /v0.1/servers/{name}/versions/latest
 */
export class MCPUpstreamClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: MCPUpstreamClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://registry.modelcontextprotocol.io/v0.1").replace(
      /\/$/,
      "",
    );
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Search for MCP servers matching the given query.
   *
   * Calls /v0.1/servers?search={query}&limit={limit}&version={version}
   * Returns validated search results.
   *
   * @param version - Optional version filter. Use `"latest"` to return only
   *   the latest version of each server.
   */
  async search(query: string, limit = 20, version?: string): Promise<UpstreamSearchResponse> {
    let url = `${this.baseUrl}/servers?search=${encodeURIComponent(query)}&limit=${String(limit)}`;
    if (version) {
      url += `&version=${encodeURIComponent(version)}`;
    }
    logger.debug("upstream registry search", { url });

    const response = await this.fetchFn(url, { headers: { Accept: "application/json" } });

    if (!response.ok) {
      throw new Error(
        `upstream registry search failed: ${String(response.status)} ${response.statusText}`,
      );
    }

    const json: unknown = await response.json();
    const envelope = UpstreamSearchEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      logger.warn("upstream registry returned malformed search envelope", {
        error: envelope.error.message,
      });
      throw new Error(`upstream registry returned invalid response: ${envelope.error.message}`);
    }

    // Parse each entry independently so one malformed entry can't poison the
    // whole response. This is the structural defense against upstream schema
    // drift — when a new field/value appears, we lose only the affected entries
    // instead of returning 502 for the whole search.
    const servers: UpstreamServerEntry[] = [];
    let dropped = 0;
    for (const raw of envelope.data.servers) {
      const parsed = UpstreamServerEntrySchema.safeParse(raw);
      if (parsed.success) {
        servers.push(parsed.data);
      } else {
        dropped++;
        const probe = NameProbeSchema.safeParse(raw);
        logger.warn("dropping malformed upstream registry entry", {
          error: parsed.error.message,
          name: probe.success ? (probe.data.server.name ?? "<unknown>") : "<unknown>",
        });
      }
    }
    if (dropped > 0) {
      logger.info("upstream search dropped malformed entries", { dropped, kept: servers.length });
    }

    return { servers, dropped };
  }

  /**
   * Fetch the latest version of a specific server by canonical name.
   *
   * Calls /v0.1/servers/{name}/versions/latest
   * URL-encodes slashes in the canonical name.
   *
   * Returns the server entry with metadata including updatedAt timestamp.
   */
  async fetchLatest(canonicalName: string): Promise<UpstreamServerEntry> {
    // URL-encode each segment of the canonical name separately
    // e.g., "io.github/Digital-Defiance/mcp-filesystem" → "io.github%2FDigital-Defiance%2Fmcp-filesystem"
    const encodedName = canonicalName.split("/").map(encodeURIComponent).join("%2F");
    const url = `${this.baseUrl}/servers/${encodedName}/versions/latest`;
    logger.debug("upstream registry fetch latest", { url, canonicalName });

    const response = await this.fetchFn(url, { headers: { Accept: "application/json" } });

    if (!response.ok) {
      throw new Error(
        `upstream registry fetch failed: ${String(response.status)} ${response.statusText}`,
      );
    }

    const json: unknown = await response.json();
    const parsed = UpstreamServerEntrySchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("upstream registry returned malformed entry", { error: parsed.error.message });
      throw new Error(`upstream registry returned invalid response: ${parsed.error.message}`);
    }

    return parsed.data;
  }
}
