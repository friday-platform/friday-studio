import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const workspaceApiSkill = {
  namespace: "tempest",
  name: "workspace-api",
  description:
    "Create, list, and manage workspaces via the daemon HTTP API. Use when the user asks to create a new workspace, space, or environment from chat.",
  getInstructions(): Promise<string> {
    return readFile(join(__dirname, "SKILL.md"), "utf-8");
  },
} as const;
