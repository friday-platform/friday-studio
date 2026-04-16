import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ValidationResult } from "./types.ts";

const KERNEL_WORKSPACE_ID = "system";
const WORKSPACE_YML_PATTERN = /^workspaces\/([^/]+)\/workspace\.yml$/;

export async function validateWorkspaceYml(
  changedFiles: string[],
  opts?: { platformUrl?: string; dispatcherWorkspaceId?: string },
): Promise<ValidationResult> {
  const platformUrl = opts?.platformUrl ?? process.env["PLATFORM_URL"] ?? "http://localhost:8080";
  const kernelId = opts?.dispatcherWorkspaceId ?? KERNEL_WORKSPACE_ID;
  const cwd = process.env["ATLAS_ROOT"] ?? process.cwd();

  const ymlFiles = changedFiles.filter((f) => WORKSPACE_YML_PATTERN.test(f));

  if (ymlFiles.length === 0) {
    return {
      validator: "workspace-yml",
      ok: true,
      message: "workspace-yml: no workspace.yml files changed",
      evidence: [],
    };
  }

  const evidence: string[] = [];
  let allOk = true;

  for (const file of ymlFiles) {
    const match = WORKSPACE_YML_PATTERN.exec(file);
    if (!match) continue;

    const workspaceId = match[1];
    if (!workspaceId) continue;

    if (workspaceId === kernelId) {
      evidence.push(`${workspaceId}: skipped (kernel workspace)`);
      continue;
    }

    let configText: string;
    try {
      configText = await readFile(path.join(cwd, file), "utf-8");
    } catch {
      evidence.push(`${workspaceId}: could not read file`);
      allOk = false;
      continue;
    }

    try {
      const res = await fetch(`${platformUrl}/api/workspaces/${workspaceId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: configText, backup: true, force: true }),
      });

      const body: unknown = await res.json();
      const success =
        typeof body === "object" &&
        body !== null &&
        "success" in body &&
        (body as Record<string, unknown>)["success"] === true;

      if (!success) {
        allOk = false;
        evidence.push(`${workspaceId}: validation failed — ${JSON.stringify(body).slice(0, 200)}`);
      } else {
        evidence.push(`${workspaceId}: ok`);
      }
    } catch (err: unknown) {
      allOk = false;
      const msg = err instanceof Error ? err.message : String(err);
      evidence.push(`${workspaceId}: fetch error — ${msg.slice(0, 200)}`);
    }
  }

  return {
    validator: "workspace-yml",
    ok: allOk,
    message: allOk ? "workspace-yml: all valid" : "workspace-yml: validation failed",
    evidence,
  };
}
