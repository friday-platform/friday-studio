import type { AgentAdapter, AgentSourceData, AgentSourceType, AgentSummary } from "./types.ts";
import { basename, join } from "@std/path";
import { expandGlob } from "@std/fs";
import { exists } from "@std/fs";
import { parse as parseYAML } from "@std/yaml";
import { createLogger } from "@atlas/logger";
import { YAMLAgentSchema } from "../../agent-conversion/yaml/schema.ts";
import z from "zod/v4";

/**
 * Loads YAML agents from the filesystem.
 * Searches for .agent.yml files in configured directories.
 */
export class YAMLFileAdapter implements AgentAdapter {
  readonly adapterName = "yaml-file-adapter";
  readonly sourceType = "yaml" as const;

  private logger = createLogger({ component: "YAMLFileAdapter" });

  constructor(
    private basePaths: string[],
    private options?: {
      /** Watch for file system changes */
      watchForChanges?: boolean;
      /** File pattern to match (default: "*.agent.yml") */
      filePattern?: string;
    },
  ) {}

  async loadAgent(id: string): Promise<AgentSourceData> {
    for (const basePath of this.basePaths) {
      const filePath = join(basePath, `${id}.agent.yml`);
      if (await exists(filePath)) {
        try {
          const content = await Deno.readTextFile(filePath);
          const stat = await Deno.stat(filePath);

          this.logger.debug("Loaded YAML agent from file", { filePath });

          return {
            type: "yaml",
            id,
            content,
            metadata: {
              sourceLocation: filePath,
              lastModified: stat.mtime ?? undefined,
            },
          };
        } catch (error) {
          const msg = `Failed to read YAML agent file ${filePath}`;
          this.logger.error(msg, { error });
          throw new Error(msg);
        }
      }
    }

    throw new Error(`YAML agent not found: ${id}`);
  }

  async listAgents(): Promise<AgentSummary[]> {
    const agents: AgentSummary[] = [];
    const seen = new Set<string>();

    for (const basePath of this.basePaths) {
      try {
        const pattern = this.options?.filePattern || "*.agent.yml";
        const globPattern = join(basePath, pattern);

        for await (const entry of expandGlob(globPattern)) {
          if (entry.isFile) {
            const id = basename(entry.name, ".agent.yml");

            if (seen.has(id)) {
              this.logger.debug("Skipping duplicate agent in path", { id, basePath });
              continue;
            }
            seen.add(id);

            try {
              const content = await Deno.readTextFile(entry.path);
              const rawYaml = parseYAML(content);
              const result = YAMLAgentSchema.safeParse(rawYaml);

              if (result.success) {
                const yaml = result.data;
                agents.push({
                  id,
                  type: "yaml" as AgentSourceType,
                  displayName: yaml.agent.displayName,
                  description: yaml.agent.description,
                  version: yaml.agent.version,
                });
                this.logger.debug("Discovered YAML agent", { id, path: entry.path });
              } else {
                this.logger.warn(`Invalid YAML agent ${entry.path}:`, {
                  validationError: z.prettifyError(result.error),
                });
              }
            } catch (error) {
              this.logger.warn("Failed to parse YAML agent", { path: entry.path, error });
            }
          }
        }
      } catch (error) {
        this.logger.warn("Failed to scan directory", { basePath, error });
      }
    }

    return agents;
  }

  async exists(id: string): Promise<boolean> {
    for (const basePath of this.basePaths) {
      const filePath = join(basePath, `${id}.agent.yml`);
      if (await exists(filePath)) {
        return true;
      }
    }
    return false;
  }

  /** Watch for changes to agent files for hot-reloading */
  async watchForChanges(callback: (event: Deno.FsEvent) => void): Promise<void> {
    if (!this.options?.watchForChanges) {
      throw new Error("Watch mode is not enabled for this adapter");
    }

    for (const basePath of this.basePaths) {
      const watcher = Deno.watchFs(basePath);
      for await (const event of watcher) {
        const isAgentFile = event.paths.some((path) => path.endsWith(".agent.yml"));
        if (isAgentFile) {
          callback(event);
        }
      }
    }
  }
}
