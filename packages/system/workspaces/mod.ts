import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";

const systemYaml = readFileSync(fileURLToPath(new URL("./system.yml", import.meta.url)), "utf-8");

export const SYSTEM_WORKSPACES: Record<string, WorkspaceConfig> = {
  system: WorkspaceConfigSchema.parse(parse(systemYaml)),
} as const;

export type SystemWorkspaceId = keyof typeof SYSTEM_WORKSPACES;
