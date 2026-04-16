import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";

const conversationYaml = readFileSync(
  fileURLToPath(new URL("./conversation.yml", import.meta.url)),
  "utf-8",
);

const systemYaml = readFileSync(fileURLToPath(new URL("./system.yml", import.meta.url)), "utf-8");

export const SYSTEM_WORKSPACES: Record<string, WorkspaceConfig> = {
  "atlas-conversation": WorkspaceConfigSchema.parse(parse(conversationYaml)),
  system: WorkspaceConfigSchema.parse(parse(systemYaml)),
} as const;

export type SystemWorkspaceId = keyof typeof SYSTEM_WORKSPACES;
