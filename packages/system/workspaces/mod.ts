// Import YAML files as text at build time
// Note: Requires --unstable-raw-imports flag in deno.json tasks
import conversationYaml from "./conversation.yml" with { type: "text" };

import { parse } from "@std/yaml";
import { WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";

// Parse and validate at module load time
export const SYSTEM_WORKSPACES: Record<string, WorkspaceConfig> = {
  "atlas-conversation": WorkspaceConfigSchema.parse(parse(conversationYaml)),
} as const;

export type SystemWorkspaceId = keyof typeof SYSTEM_WORKSPACES;
