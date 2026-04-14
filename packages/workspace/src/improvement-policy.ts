import { randomUUID } from "node:crypto";
import type { ScratchpadAdapter, ScratchpadChunk } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import {
  type ImprovementMode,
  resolveImprovementMode,
  type WorkspaceImprovementConfig,
} from "./config-schema.ts";

const log = createLogger({ component: "improvement-policy" });

export type { ImprovementMode, WorkspaceImprovementConfig };

export async function applyFinding(params: {
  workspaceId: string;
  jobId?: string;
  cfg: WorkspaceImprovementConfig;
  proposedConfig: Record<string, unknown>;
  scratchpad: ScratchpadAdapter;
  daemonBaseUrl: string;
}): Promise<{ mode: ImprovementMode; result: "applied" | "surfaced" }> {
  const mode = resolveImprovementMode(params.cfg, params.jobId);

  if (mode === "auto") {
    const res = await fetch(
      `${params.daemonBaseUrl}/api/workspaces/${params.workspaceId}/update?backup=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params.proposedConfig),
      },
    );
    if (!res.ok) {
      throw new Error(`Daemon update failed: ${res.status} ${await res.text()}`);
    }
    log.info("Auto mode: applied config update with backup", {
      workspaceId: params.workspaceId,
      status: res.status,
    });
    return { mode, result: "applied" };
  }

  const chunk: ScratchpadChunk = {
    id: randomUUID(),
    kind: "proposed-config",
    body: JSON.stringify(params.proposedConfig, null, 2),
    createdAt: new Date().toISOString(),
  };
  await params.scratchpad.append(`${params.workspaceId}/notes`, chunk);

  log.info("Surface mode: wrote proposed config to scratchpad", {
    workspaceId: params.workspaceId,
    chunkId: chunk.id,
  });
  return { mode, result: "surfaced" };
}
