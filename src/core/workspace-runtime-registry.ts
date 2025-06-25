/**
 * WorkspaceRuntimeRegistry - Tracks active WorkspaceRuntime instances
 * This is the proper way for MCP to discover and communicate with running workspaces
 */

import { logger } from "../utils/logger.ts";
import type { WorkspaceRuntime } from "./workspace-runtime.ts";
import type { IWorkspace, IWorkspaceSignal } from "../types/core.ts";

export interface RuntimeWorkspaceInfo {
  id: string;
  name: string;
  description?: string;
  runtime: WorkspaceRuntime;
  status: string;
  startedAt: Date;
  sessions: number;
  workers: number;
}

/**
 * Singleton registry that tracks all active WorkspaceRuntime instances
 * MCP servers should use this instead of reading static config files
 */
export class WorkspaceRuntimeRegistry {
  private static instance: WorkspaceRuntimeRegistry;
  private runtimes = new Map<string, RuntimeWorkspaceInfo>();

  private constructor() {}

  static getInstance(): WorkspaceRuntimeRegistry {
    if (!WorkspaceRuntimeRegistry.instance) {
      WorkspaceRuntimeRegistry.instance = new WorkspaceRuntimeRegistry();
    }
    return WorkspaceRuntimeRegistry.instance;
  }

  /**
   * Register a WorkspaceRuntime instance
   */
  register(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    _workspace: IWorkspace,
    metadata?: { name?: string; description?: string },
  ): void {
    const info: RuntimeWorkspaceInfo = {
      id: workspaceId,
      name: metadata?.name || workspaceId,
      description: metadata?.description,
      runtime,
      status: runtime.getState(),
      startedAt: new Date(),
      sessions: runtime.getSessions().length,
      workers: runtime.getWorkers().length,
    };

    this.runtimes.set(workspaceId, info);

    logger.info("Workspace runtime registered", {
      workspaceId,
      name: info.name,
      status: info.status,
    });
  }

  /**
   * Unregister a WorkspaceRuntime instance
   */
  unregister(workspaceId: string): void {
    const info = this.runtimes.get(workspaceId);
    if (info) {
      this.runtimes.delete(workspaceId);
      logger.info("Workspace runtime unregistered", {
        workspaceId,
        name: info.name,
      });
    }
  }

  /**
   * Get all active workspace runtimes
   */
  listWorkspaces(): Array<
    {
      id: string;
      name: string;
      description?: string;
      status: string;
      startedAt: string;
      sessions: number;
      workers: number;
    }
  > {
    return Array.from(this.runtimes.values()).map((info) => ({
      id: info.id,
      name: info.name,
      description: info.description,
      status: info.runtime.getState(),
      startedAt: info.startedAt.toISOString(),
      sessions: info.runtime.getSessions().length,
      workers: info.runtime.getWorkers().length,
    }));
  }

  /**
   * Get a specific workspace runtime
   */
  getWorkspace(workspaceId: string): RuntimeWorkspaceInfo | undefined {
    return this.runtimes.get(workspaceId);
  }

  /**
   * Get detailed workspace information including live runtime status
   */
  async describeWorkspace(workspaceId: string): Promise<{
    id: string;
    name: string;
    description?: string;
    status: string;
    startedAt: string;
    runtime: {
      supervisor: string | undefined;
      sessions: number;
      workers: {
        total: number;
        byType: {
          supervisor: number;
          session: number;
          agent: number;
        };
      };
    };
    sessions: Array<{ id: string; status: string; startedAt: string }>;
    jobs: Array<{ name: string; description?: string }>;
    signals: Array<{ name: string; description?: string }>;
    agents: Array<{ id: string; type: string; purpose?: string }>;
  }> {
    const info = this.runtimes.get(workspaceId);
    if (!info) {
      throw new Error(`Workspace '${workspaceId}' not found or not running`);
    }

    const status = info.runtime.getStatus();
    const sessions = await info.runtime.listSessions();
    const jobs = await info.runtime.listJobs();
    const signals = await info.runtime.listSignals();
    const agents = await info.runtime.listAgents();

    return {
      id: info.id,
      name: info.name,
      description: info.description,
      status: status.state,
      startedAt: info.startedAt.toISOString(),
      runtime: {
        supervisor: status.supervisor,
        sessions: status.sessions,
        workers: status.workers,
      },
      sessions: sessions.map((session) => ({
        id: session.id,
        status: session.status,
        startedAt: session.startedAt,
      })),
      jobs: jobs.map((job) => ({
        name: job.name,
        description: job.description,
      })),
      signals: signals.map((signal) => ({
        name: signal.name,
        description: signal.description,
      })),
      agents: agents.map((agent) => ({
        id: agent.id,
        type: agent.type,
        purpose: agent.purpose,
      })),
    };
  }

  /**
   * Create a new workspace (delegates to appropriate workspace factory)
   */
  createWorkspace(
    _config: {
      name: string;
      description?: string;
      template?: string;
      config?: Record<string, unknown>;
    },
  ): Promise<{ id: string; name: string }> {
    // This should delegate to workspace creation logic
    // For now, throw an error since this needs proper implementation
    throw new Error(
      "Workspace creation through runtime registry not yet implemented. Use workspace CLI commands instead.",
    );
  }

  /**
   * Delete a workspace (shuts down runtime and cleans up)
   */
  async deleteWorkspace(workspaceId: string, force?: boolean): Promise<void> {
    const info = this.runtimes.get(workspaceId);
    if (!info) {
      throw new Error(`Workspace '${workspaceId}' not found or not running`);
    }

    // Shutdown the runtime
    await info.runtime.shutdown();

    // Remove from registry
    this.unregister(workspaceId);

    logger.info("Workspace deleted", {
      workspaceId,
      name: info.name,
      force,
    });
  }

  /**
   * Process a signal through a specific workspace runtime
   */
  async processSignal(
    workspaceId: string,
    signalName: string,
    payload: Record<string, unknown>,
  ): Promise<{ sessionId: string }> {
    const info = this.runtimes.get(workspaceId);
    if (!info) {
      throw new Error(`Workspace '${workspaceId}' not found or not running`);
    }

    // Get the signal configuration from the workspace
    const signals = await info.runtime.listSignals();
    const signalConfig = signals.find((s) => s.name === signalName);
    if (!signalConfig) {
      throw new Error(`Signal '${signalName}' not found in workspace '${workspaceId}'`);
    }

    // Create a signal object with minimal implementation for runtime processing
    const signal = {
      id: signalName,
      provider: { id: "mcp", name: "MCP" },
      // Pass through signal config for runtime to process
      ...signalConfig,
    } as unknown as IWorkspaceSignal;

    // Process through the runtime
    const session = await info.runtime.processSignal(signal, payload);

    return { sessionId: session.id || crypto.randomUUID() };
  }

  /**
   * Trigger a job through a specific workspace runtime
   */
  async triggerJob(
    workspaceId: string,
    jobName: string,
    payload?: Record<string, unknown>,
  ): Promise<{ sessionId: string }> {
    const info = this.runtimes.get(workspaceId);
    if (!info) {
      throw new Error(`Workspace '${workspaceId}' not found or not running`);
    }

    return await info.runtime.triggerJob(jobName, payload);
  }

  /**
   * List jobs for a specific workspace
   */
  async listJobs(workspaceId: string): Promise<Array<{ name: string; description?: string }>> {
    const info = this.runtimes.get(workspaceId);
    if (!info) {
      throw new Error(`Workspace '${workspaceId}' not found or not running`);
    }

    return await info.runtime.listJobs();
  }

  /**
   * List sessions for a specific workspace
   */
  async listSessions(
    workspaceId: string,
  ): Promise<Array<{ id: string; status: string; startedAt: string }>> {
    const info = this.runtimes.get(workspaceId);
    if (!info) {
      throw new Error(`Workspace '${workspaceId}' not found or not running`);
    }

    return await info.runtime.listSessions();
  }

  /**
   * Get count of active workspaces
   */
  getActiveCount(): number {
    return this.runtimes.size;
  }

  /**
   * Check if a workspace is running
   */
  isRunning(workspaceId: string): boolean {
    return this.runtimes.has(workspaceId);
  }

  /**
   * Get all workspace IDs
   */
  getWorkspaceIds(): string[] {
    return Array.from(this.runtimes.keys());
  }
}
