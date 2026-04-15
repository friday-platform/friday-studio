import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@atlas/logger";
import { getAtlasHome } from "@atlas/utils/paths.server";
import type { WorkspaceManager } from "./manager.ts";

export const USER_WORKSPACE_ID = "user" as const;

const templateYaml = readFileSync(
  fileURLToPath(new URL("./user-workspace-template.yml", import.meta.url)),
  "utf-8",
);

export async function ensureDefaultUserWorkspace(manager: WorkspaceManager): Promise<void> {
  const existing = await manager.find({ id: USER_WORKSPACE_ID });
  if (existing) return;

  const nonSystem = await manager.list({ includeSystem: false });
  if (nonSystem.length > 0) return;

  const dir = join(getAtlasHome(), "workspaces", USER_WORKSPACE_ID);
  await mkdir(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.yml"), templateYaml, "utf-8");

  await manager.registerWorkspace(dir, { id: USER_WORKSPACE_ID });

  logger.info("Default user workspace created", { id: USER_WORKSPACE_ID });
}
