import { parseResult, client as v2Client } from "@atlas/client/v2";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import { getDaemonClient } from "../../utils/daemon-client.ts";
import { getCurrentWorkspaceName } from "../../utils/workspace-name.ts";

const jsonRecordSchema = z.record(z.string(), z.unknown());

interface TriggerSignalOptions {
  workspaceId: string;
  signalName: string;
  payload?: Record<string, unknown>;
}

interface TriggerSignalResult {
  success: boolean;
  sessionId?: string;
  status?: string;
  error?: string;
  duration: number;
  workspaceId: string;
  workspaceName?: string;
}

interface WorkspaceTarget {
  id: string;
  name: string;
}

interface BatchTriggerOptions {
  signalName: string;
  payload?: Record<string, unknown>;
  workspaceIds?: string[];
  all?: boolean;
  exclude?: string[];
}

interface BatchTriggerResult {
  signal: string;
  timestamp: string;
  results: Array<{
    workspaceId: string;
    workspaceName: string;
    success: boolean;
    result?: { sessionId?: string; status?: string };
    error?: string;
  }>;
}

/**
 * Validates and parses signal payload from JSON string
 */
export function validateSignalPayload(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data);
    return jsonRecordSchema.parse(parsed);
  } catch (error) {
    throw new Error(`Invalid JSON data: ${stringifyError(error)}`);
  }
}

/**
 * Resolves workspace targets based on names/IDs, with fallback to current workspace
 */
async function resolveWorkspaceTargets(
  workspaceNames?: string[],
  excludeNames?: string[],
  all?: boolean,
): Promise<WorkspaceTarget[]> {
  // Get client - it will auto-start daemon if needed
  const client = getDaemonClient();
  const targetWorkspaces: WorkspaceTarget[] = [];
  const excludeSet = new Set(excludeNames || []);

  if (all) {
    // Get all workspaces
    const allWorkspaces = await parseResult(v2Client.workspace.index.$get());
    if (!allWorkspaces.ok) {
      throw new Error("Failed to retrieve workspaces");
    }
    for (const workspace of allWorkspaces.data) {
      if (!excludeSet.has(workspace.id) && !excludeSet.has(workspace.name)) {
        targetWorkspaces.push({ id: workspace.id, name: workspace.name });
      }
    }
  } else if (workspaceNames && workspaceNames.length > 0) {
    // Use specific workspace(s)
    for (const workspaceName of workspaceNames) {
      try {
        const workspace = await client.getWorkspace(workspaceName);
        if (!excludeSet.has(workspace.id) && !excludeSet.has(workspace.name)) {
          targetWorkspaces.push({ id: workspace.id, name: workspace.name });
        }
      } catch {
        // Try to find by name if ID lookup failed
        const allWorkspaces = await parseResult(v2Client.workspace.index.$get());
        if (!allWorkspaces.ok) {
          throw new Error("Failed to retrieve workspaces");
        }
        const foundWorkspace = allWorkspaces.data.find((w) => w.name === workspaceName);
        if (
          foundWorkspace &&
          !excludeSet.has(foundWorkspace.id) &&
          !excludeSet.has(foundWorkspace.name)
        ) {
          targetWorkspaces.push({ id: foundWorkspace.id, name: foundWorkspace.name });
        } else {
          throw new Error(`Workspace '${workspaceName}' not found`);
        }
      }
    }
  } else {
    // Use current workspace
    const currentWorkspaceName = await getCurrentWorkspaceName();

    if (!currentWorkspaceName) {
      throw new Error("No workspace.yml found in current directory. Specify target workspace.");
    }

    // Find workspace by name in daemon
    const allWorkspaces = await parseResult(v2Client.workspace.index.$get());
    if (!allWorkspaces.ok) {
      throw new Error("Failed to retrieve workspaces");
    }
    const currentWorkspace = allWorkspaces.data.find((w) => w.name === currentWorkspaceName);

    if (!currentWorkspace) {
      throw new Error(`Current workspace '${currentWorkspaceName}' not found in daemon.`);
    }

    if (!excludeSet.has(currentWorkspace.id) && !excludeSet.has(currentWorkspace.name)) {
      targetWorkspaces.push({ id: currentWorkspace.id, name: currentWorkspace.name });
    }
  }

  if (targetWorkspaces.length === 0) {
    throw new Error("No target workspaces found after filtering.");
  }

  return targetWorkspaces;
}

/**
 * Triggers a signal on a single workspace
 */
async function triggerSignal(options: TriggerSignalOptions): Promise<TriggerSignalResult> {
  const startTime = performance.now();

  try {
    // Get client - it will auto-start daemon if needed
    const client = getDaemonClient();

    // Get workspace info for result
    const workspace = await client.getWorkspace(options.workspaceId);

    const response = await parseResult(
      v2Client.workspace[":workspaceId"].signals[":signalId"].$post({
        param: { workspaceId: options.workspaceId, signalId: options.signalName },
        json: { payload: options.payload },
      }),
    );

    const duration = performance.now() - startTime;
    if (!response.ok) {
      return {
        duration,
        workspaceId: options.workspaceId,
        success: false,
        error: stringifyError(response.error),
      };
    }
    return {
      success: true,
      status: response.data.status,
      duration,
      workspaceId: options.workspaceId,
      workspaceName: workspace.name,
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    return {
      success: false,
      error: stringifyError(error),
      duration,
      workspaceId: options.workspaceId,
    };
  }
}

/**
 * Triggers a signal on multiple workspaces
 */
export async function batchTriggerSignal(
  options: BatchTriggerOptions,
): Promise<BatchTriggerResult> {
  const targetWorkspaces = await resolveWorkspaceTargets(
    options.workspaceIds,
    options.exclude,
    options.all,
  );

  const results: BatchTriggerResult["results"] = [];

  for (const workspace of targetWorkspaces) {
    const result = await triggerSignal({
      workspaceId: workspace.id,
      signalName: options.signalName,
      payload: options.payload,
    });

    results.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      success: result.success,
      result: result.success ? { sessionId: result.sessionId, status: result.status } : undefined,
      error: result.error,
    });
  }

  return { signal: options.signalName, timestamp: new Date().toISOString(), results };
}

interface StreamTriggerOptions {
  signalName: string;
  payload?: Record<string, unknown>;
  workspaceIds?: string[];
  all?: boolean;
  exclude?: string[];
  onEvent: (event: Record<string, unknown>) => void;
}

/**
 * Triggers a signal on a single workspace via SSE and streams events back.
 * Only targets the first resolved workspace (SSE is a single-connection protocol).
 */
export async function streamTriggerSignal(options: StreamTriggerOptions): Promise<void> {
  const targets = await resolveWorkspaceTargets(options.workspaceIds, options.exclude, options.all);
  const target = targets[0];
  if (!target) {
    throw new Error("No target workspaces found");
  }

  const baseUrl = getAtlasDaemonUrl();
  const url = `${baseUrl}/api/workspaces/${encodeURIComponent(target.id)}/signals/${encodeURIComponent(options.signalName)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ payload: options.payload }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Signal trigger failed (${response.status}): ${text}`);
  }

  if (!response.body) {
    throw new Error("No response body from SSE stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    for (
      let newlineIdx = buffer.indexOf("\n");
      newlineIdx !== -1;
      newlineIdx = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = jsonRecordSchema.parse(JSON.parse(data));
        options.onEvent(parsed);
      } catch {
        // Non-JSON SSE data line — print raw
        options.onEvent({ type: "raw", data });
      }
    }
  }
}
