import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentLLMConfigSchema, MCPServerConfigSchema } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { z } from "zod";
import { AgentNotFoundError } from "../errors.ts";
import type { AgentAdapter, AgentSourceData, AgentSummary } from "./types.ts";

/** Parsed version directory: agent ID + semver version + full path */
interface VersionEntry {
  id: string;
  version: string;
  path: string;
}

/** Minimal shape of the metadata.json sidecar — validates disk boundary */
const AgentMetadataFileSchema = z.object({
  id: z.string(),
  version: z.string(),
  displayName: z.string().optional(),
  description: z.string(),
  llm: AgentLLMConfigSchema.optional(),
  mcp: z.record(z.string(), MCPServerConfigSchema).optional(),
  useWorkspaceSkills: z.boolean().optional(),
  entrypoint: z.string().optional(),
  hash: z.string().optional(),
  // Authoring metadata added in friday-agent-sdk 0.1.0+. All optional so
  // older sidecars (pre-field-set) still parse cleanly.
  summary: z.string().optional(),
  constraints: z.string().optional(),
  expertise: z.object({ examples: z.array(z.string()) }).optional(),
  environment: z.record(z.string(), z.unknown()).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Compare two semver strings. Returns positive if a > b, negative if a < b, 0 if equal.
 * Handles standard major.minor.patch format.
 */
function compareSemver(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Parse a directory name in `{id}@{version}` format.
 * Returns null if the name doesn't match or ends with `.tmp`.
 */
function parseVersionDir(name: string): { id: string; version: string } | null {
  if (name.endsWith(".tmp")) return null;
  const atIndex = name.lastIndexOf("@");
  if (atIndex <= 0) return null;
  const id = name.slice(0, atIndex);
  const version = name.slice(atIndex + 1);
  if (!version) return null;
  return { id, version };
}

/**
 * Loads user-built agents from disk.
 * Discovers agents at `{agentsDir}/{id}@{version}/` by reading
 * `metadata.json` sidecar files.
 */
export class UserAdapter implements AgentAdapter {
  readonly adapterName = "user-agent-adapter";
  readonly sourceType = "user" as const;

  private logger = createLogger({ component: "UserAdapter" });

  constructor(private agentsDir: string) {}

  async listAgents(): Promise<AgentSummary[]> {
    const entries = await this.scanVersionDirs();
    if (entries.length === 0) return [];

    // Group by agent ID, pick highest semver per group
    const grouped = new Map<string, VersionEntry>();
    for (const entry of entries) {
      const existing = grouped.get(entry.id);
      if (!existing || compareSemver(entry.version, existing.version) > 0) {
        grouped.set(entry.id, entry);
      }
    }

    const summaries: AgentSummary[] = [];
    for (const entry of grouped.values()) {
      try {
        const metadata = await this.readMetadata(entry.path);
        summaries.push({
          id: metadata.id,
          type: "user",
          displayName: metadata.displayName,
          description: metadata.description,
          version: metadata.version,
          summary: metadata.summary,
          constraints: metadata.constraints,
          expertise: metadata.expertise,
          environment: metadata.environment,
          inputSchema: metadata.inputSchema,
          outputSchema: metadata.outputSchema,
          sourceLocation: entry.path,
        });
      } catch (error) {
        this.logger.warn("Skipping agent with unreadable metadata", { path: entry.path, error });
      }
    }

    return summaries;
  }

  async loadAgent(id: string): Promise<AgentSourceData> {
    const latest = await this.resolveLatestVersion(id);
    if (!latest) {
      throw new AgentNotFoundError(id, "User");
    }

    const metadata = await this.readMetadata(latest.path);

    return {
      type: "user",
      id,
      metadata: {
        sourceLocation: latest.path,
        version: metadata.version,
        llm: metadata.llm,
        mcp: metadata.mcp,
        useWorkspaceSkills: metadata.useWorkspaceSkills,
        entrypoint: metadata.entrypoint,
      },
    };
  }

  async exists(id: string): Promise<boolean> {
    const entries = await this.scanVersionDirs();
    return entries.some((e) => e.id === id);
  }

  /** Scan the agents directory for valid `{id}@{version}/` directories */
  private async scanVersionDirs(): Promise<VersionEntry[]> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(this.agentsDir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist — no agents
      return [];
    }

    const entries: VersionEntry[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const parsed = parseVersionDir(dirent.name);
      if (!parsed) continue;
      entries.push({
        id: parsed.id,
        version: parsed.version,
        path: join(this.agentsDir, dirent.name),
      });
    }
    return entries;
  }

  /** Read and parse metadata.json from an agent version directory */
  private async readMetadata(versionDir: string): Promise<z.infer<typeof AgentMetadataFileSchema>> {
    const content = await readFile(join(versionDir, "metadata.json"), "utf-8");
    const json: unknown = JSON.parse(content);
    return AgentMetadataFileSchema.parse(json);
  }

  /** Find the latest version directory for a given agent ID */
  private async resolveLatestVersion(id: string): Promise<VersionEntry | null> {
    const entries = await this.scanVersionDirs();
    let latest: VersionEntry | null = null;
    for (const entry of entries) {
      if (entry.id !== id) continue;
      if (!latest || compareSemver(entry.version, latest.version) > 0) {
        latest = entry;
      }
    }
    return latest;
  }
}
