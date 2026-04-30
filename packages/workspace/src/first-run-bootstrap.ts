import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { WorkspaceManager } from "./manager.ts";

export const USER_WORKSPACE_ID = "user" as const;

const templateYaml = readFileSync(
  fileURLToPath(new URL("./user-workspace-template.yml", import.meta.url)),
  "utf-8",
);

export async function ensureDefaultUserWorkspace(manager: WorkspaceManager): Promise<void> {
  // The `user` workspace is the stable personal scope every authenticated chat
  // routes into. It must exist in every installation, not just fresh ones —
  // the previous first-run guard (`nonSystem.length > 0`) bailed out whenever
  // FAST kernel workspaces (frozen_granola, fizzy_waffle, poached_quiche) were
  // already present, leaving `POST /api/chat` with a broken reference to a
  // missing workspace. We now only skip if `user` itself already exists.
  const existing = await manager.find({ id: USER_WORKSPACE_ID });
  if (existing) return;

  const dir = join(getFridayHome(), "workspaces", USER_WORKSPACE_ID);
  await mkdir(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.yml"), templateYaml, "utf-8");

  await manager.registerWorkspace(dir, { id: USER_WORKSPACE_ID, canonical: "personal" });

  logger.info("Default user workspace created", { id: USER_WORKSPACE_ID });
}
