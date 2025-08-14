import { getDaemonClient } from "../../utils/daemon-client.ts";
import { getCurrentWorkspaceName } from "../../utils/workspace-name.ts";

export interface TriggerSignalOptions {
  workspaceId: string;
  signalName: string;
  payload?: Record<string, unknown>;
}

export interface TriggerSignalResult {
  success: boolean;
  sessionId?: string;
  status?: string;
  error?: string;
  duration: number;
  workspaceId: string;
  workspaceName?: string;
}

export interface WorkspaceTarget {
  id: string;
  name: string;
}

export interface BatchTriggerOptions {
  signalName: string;
  payload?: Record<string, unknown>;
  workspaceIds?: string[];
  all?: boolean;
  exclude?: string[];
}

export interface BatchTriggerResult {
  signal: string;
  timestamp: string;
  results: Array<{
    workspaceId: string;
    workspaceName: string;
    success: boolean;
    result?: {
      sessionId?: string;
      status?: string;
    };
    error?: string;
  }>;
}

/**
 * Validates and parses signal payload from JSON string
 */
export function validateSignalPayload(data: string): Record<string, unknown> {
  try {
    return { payload: JSON.parse(data) };
  } catch (err) {
    throw new Error(
      `Invalid JSON data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolves workspace targets based on names/IDs, with fallback to current workspace
 */
export async function resolveWorkspaceTargets(
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
    const allWorkspaces = await client.listWorkspaces();
    for (const workspace of allWorkspaces) {
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
      } catch (error) {
        // Try to find by name if ID lookup failed
        const allWorkspaces = await client.listWorkspaces();
        const foundWorkspace = allWorkspaces.find(
          (w) => w.name === workspaceName,
        );
        if (
          foundWorkspace &&
          !excludeSet.has(foundWorkspace.id) &&
          !excludeSet.has(foundWorkspace.name)
        ) {
          targetWorkspaces.push({
            id: foundWorkspace.id,
            name: foundWorkspace.name,
          });
        } else {
          throw new Error(`Workspace '${workspaceName}' not found`);
        }
      }
    }
  } else {
    // Use current workspace
    const currentWorkspaceName = await getCurrentWorkspaceName();

    if (!currentWorkspaceName) {
      throw new Error(
        "No workspace.yml found in current directory. Specify target workspace.",
      );
    }

    // Find workspace by name in daemon
    const allWorkspaces = await client.listWorkspaces();
    const currentWorkspace = allWorkspaces.find(
      (w) => w.name === currentWorkspaceName,
    );

    if (!currentWorkspace) {
      throw new Error(
        `Current workspace '${currentWorkspaceName}' not found in daemon.`,
      );
    }

    if (
      !excludeSet.has(currentWorkspace.id) &&
      !excludeSet.has(currentWorkspace.name)
    ) {
      targetWorkspaces.push({
        id: currentWorkspace.id,
        name: currentWorkspace.name,
      });
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
export async function triggerSignal(
  options: TriggerSignalOptions,
): Promise<TriggerSignalResult> {
  const startTime = performance.now();

  try {
    // Get client - it will auto-start daemon if needed
    const client = getDaemonClient();

    // Get workspace info for result
    const workspace = await client.getWorkspace(options.workspaceId);

    const result = await client.triggerSignal(
      options.workspaceId,
      options.signalName,
      options.payload || {},
    );

    const duration = performance.now() - startTime;

    return {
      success: true,
      status: result.status,
      duration,
      workspaceId: options.workspaceId,
      workspaceName: workspace.name,
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
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
      result: result.success
        ? {
          sessionId: result.sessionId,
          status: result.status,
        }
        : undefined,
      error: result.error,
    });
  }

  return {
    signal: options.signalName,
    timestamp: new Date().toISOString(),
    results,
  };
}

/**
 * Simple trigger function for single workspace/signal (used by interactive UI)
 */
export async function triggerSignalSimple(
  workspaceId: string,
  signalName: string,
  payload?: string,
): Promise<TriggerSignalResult> {
  const parsedPayload = payload ? validateSignalPayload(payload) : undefined;

  return await triggerSignal({
    workspaceId,
    signalName,
    payload: parsedPayload,
  });
}
