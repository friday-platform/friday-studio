import { randomUUID } from "node:crypto";
import type { ScratchpadAdapter, ScratchpadChunk } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { stringify as yamlStringify } from "@std/yaml";
import {
  type ImprovementPolicy,
  resolveImprovementPolicy,
  type WorkspaceImprovementConfig,
} from "./config-schema.ts";

const log = createLogger({ component: "improvement-policy" });

export type { ImprovementPolicy, WorkspaceImprovementConfig };

export interface Finding {
  jobId?: string;
  workspaceId: string;
  sessionKey: string;
  proposedConfig: Record<string, unknown>;
}

export interface ApplyFindingDeps {
  scratchpad: ScratchpadAdapter;
  daemonBaseUrl: string;
}

export async function applyFinding(
  config: WorkspaceImprovementConfig,
  finding: Finding,
  deps: ApplyFindingDeps,
): Promise<void> {
  const policy = resolveImprovementPolicy(config, finding.jobId);

  if (policy === "surface") {
    await applySurface(finding, deps.scratchpad);
  } else {
    await applyAuto(finding, deps.daemonBaseUrl);
  }
}

async function applySurface(finding: Finding, scratchpad: ScratchpadAdapter): Promise<void> {
  const chunk: ScratchpadChunk = {
    id: randomUUID(),
    kind: "proposed-config",
    body: yamlStringify(finding.proposedConfig),
    createdAt: new Date().toISOString(),
  };

  await scratchpad.append(finding.sessionKey, chunk);

  log.info("Surface mode: wrote proposed config to scratchpad", {
    workspaceId: finding.workspaceId,
    sessionKey: finding.sessionKey,
    chunkId: chunk.id,
  });
}

async function applyAuto(finding: Finding, daemonBaseUrl: string): Promise<void> {
  const url = `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(finding.workspaceId)}/update`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: finding.proposedConfig, backup: true }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auto-mode update failed (${response.status}): ${text}`);
  }

  log.info("Auto mode: applied config update with backup", {
    workspaceId: finding.workspaceId,
    status: response.status,
  });
}
