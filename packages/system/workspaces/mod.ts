import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";

const conversationYaml = readFileSync(
  fileURLToPath(new URL("./conversation.yml", import.meta.url)),
  "utf-8",
);

export const SYSTEM_WORKSPACES: Record<string, WorkspaceConfig> = {
  "friday-conversation": WorkspaceConfigSchema.parse(parse(conversationYaml)),
} as const;

export type SystemWorkspaceId = keyof typeof SYSTEM_WORKSPACES;
