import { assign, createActor, createMachine } from "xstate";
import { logger } from "../../utils/logger.ts";

// Worker lifecycle states
export type WorkerState =
  | "idle"
  | "initializing"
  | "ready"
  | "processing"
  | "error"
  | "terminating"
  | "terminated";

// Worker types in the system
export type WorkerType = "supervisor" | "session" | "agent";

// Worker metadata
export interface WorkerMetadata {
  id: string;
  type: WorkerType;
  parentId?: string;
  config?: any;
}

// Worker instance with state machine
export interface ManagedWorker {
  id: string;
  type: WorkerType;
  worker: Worker;
  actor: any; // XState actor
  ports: Map<string, MessagePort>;
  broadcastChannel?: BroadcastChannel;
  metadata: WorkerMetadata;
}

// Events for worker state machine
export type WorkerEvent =
  | { type: "INITIALIZE"; config?: any }
  | { type: "INITIALIZED" }
  | { type: "START_PROCESSING"; taskId: string }
  | { type: "COMPLETE_PROCESSING"; taskId: string; result?: any }
  | { type: "ERROR"; error: string }
  | { type: "TERMINATE" }
  | { type: "TERMINATED" };

// Worker state machine context
interface WorkerContext {
  id: string;
  type: WorkerType;
  error?: string;
  currentTask?: string;
  initialized: boolean;
}

// Create state machine for individual workers
export function createWorkerMachine(id: string, type: WorkerType) {
  return createMachine({
    id: `worker-${id}`,
    initial: "idle",
    context: {
      id,
      type,
      initialized: false,
    } as WorkerContext,
    states: {
      idle: {
        on: {
          INITIALIZE: {
            target: "initializing",
          },
        },
      },
      initializing: {
        on: {
          INITIALIZED: {
            target: "ready",
            actions: assign({
              initialized: true,
            }),
          },
          ERROR: {
            target: "error",
            actions: assign({
              error: ({ event }) => event.error,
            }),
          },
        },
      },
      ready: {
        on: {
          START_PROCESSING: {
            target: "processing",
            actions: assign({
              currentTask: ({ event }) => event.taskId,
            }),
          },
          TERMINATE: {
            target: "terminating",
          },
        },
      },
      processing: {
        on: {
          COMPLETE_PROCESSING: {
            target: "ready",
            actions: assign({
              currentTask: undefined,
            }),
          },
          ERROR: {
            target: "error",
            actions: assign({
              error: ({ event }) => event.error,
              currentTask: undefined,
            }),
          },
        },
      },
      error: {
        on: {
          INITIALIZE: {
            target: "initializing",
            actions: assign({
              error: undefined,
            }),
          },
          TERMINATE: {
            target: "terminating",
          },
        },
      },
      terminating: {
        on: {
          TERMINATED: {
            target: "terminated",
          },
        },
        entry: ({ context }) => {
          logger.info(`Terminating worker`, {
            workerId: context.id,
            workerType: context.type,
          });
        },
      },
      terminated: {
        type: "final",
      },
    },
  });
}

// Main WorkerManager state machine context
interface WorkerManagerContext {
  workers: Map<string, ManagedWorker>;
  workersByType: Map<WorkerType, Set<string>>;
  activeTasks: Map<string, string>; // taskId -> workerId
}

// WorkerManager events
export type WorkerManagerEvent =
  | { type: "SPAWN_WORKER"; metadata: WorkerMetadata; url: string }
  | { type: "WORKER_SPAWNED"; workerId: string }
  | { type: "TERMINATE_WORKER"; workerId: string }
  | { type: "WORKER_TERMINATED"; workerId: string }
  | { type: "ASSIGN_TASK"; workerId: string; taskId: string }
  | { type: "TASK_COMPLETED"; workerId: string; taskId: string }
  | { type: "BROADCAST"; channel: string; message: any }
  | { type: "SHUTDOWN" };

// Create the main WorkerManager state machine
export function createWorkerManagerMachine() {
  return createMachine({
    id: "worker-manager",
    initial: "active",
    context: {
      workers: new Map(),
      workersByType: new Map([
        ["supervisor", new Set()],
        ["session", new Set()],
        ["agent", new Set()],
      ]),
      activeTasks: new Map(),
    } as WorkerManagerContext,
    states: {
      active: {
        on: {
          SPAWN_WORKER: {
            actions: "spawnWorker",
          },
          WORKER_SPAWNED: {
            actions: "registerWorker",
          },
          TERMINATE_WORKER: {
            actions: "terminateWorker",
          },
          WORKER_TERMINATED: {
            actions: "unregisterWorker",
          },
          ASSIGN_TASK: {
            actions: "assignTask",
          },
          TASK_COMPLETED: {
            actions: "completeTask",
          },
          BROADCAST: {
            actions: "broadcastMessage",
          },
          SHUTDOWN: {
            target: "shuttingDown",
          },
        },
      },
      shuttingDown: {
        entry: "initiateShutdown",
        on: {
          WORKER_TERMINATED: {
            actions: "unregisterWorker",
            guard: ({ context }) => context.workers.size === 0,
            target: "terminated",
          },
        },
      },
      terminated: {
        type: "final",
      },
    },
  });
}

// Worker pool for reusing workers
interface WorkerPool {
  available: ManagedWorker[];
  inUse: Map<string, ManagedWorker>;
  maxSize: number;
}

// WorkerManager utility class
export class WorkerManager {
  private actor: any;
  private workers: Map<string, ManagedWorker> = new Map();
  private pools: Map<WorkerType, WorkerPool> = new Map();

  constructor() {
    // Initialize worker pools
    this.pools.set("supervisor", { available: [], inUse: new Map(), maxSize: 3 });
    this.pools.set("session", { available: [], inUse: new Map(), maxSize: 5 });
    this.pools.set("agent", { available: [], inUse: new Map(), maxSize: 10 });

    const machine = createWorkerManagerMachine().provide({
      actions: {
        spawnWorker: ({ context: _context, event }) => {
          if (event.type === "SPAWN_WORKER") {
            this.spawnWorker(event.metadata, event.url);
          }
        },
        registerWorker: ({ context, event }) => {
          if (event.type === "WORKER_SPAWNED") {
            const worker = this.workers.get(event.workerId);
            if (worker) {
              context.workers.set(event.workerId, worker);
              context.workersByType.get(worker.type)?.add(event.workerId);
            }
          }
        },
        terminateWorker: ({ context: _context, event }) => {
          if (event.type === "TERMINATE_WORKER") {
            this.terminateWorker(event.workerId);
          }
        },
        unregisterWorker: ({ context, event }) => {
          if (event.type === "WORKER_TERMINATED") {
            const worker = context.workers.get(event.workerId);
            if (worker) {
              context.workers.delete(event.workerId);
              context.workersByType.get(worker.type)?.delete(event.workerId);
            }
          }
        },
        assignTask: ({ context, event }) => {
          if (event.type === "ASSIGN_TASK") {
            context.activeTasks.set(event.taskId, event.workerId);
            const worker = this.workers.get(event.workerId);
            worker?.actor.send({
              type: "START_PROCESSING",
              taskId: event.taskId,
            });
          }
        },
        completeTask: ({ context, event }) => {
          if (event.type === "TASK_COMPLETED") {
            context.activeTasks.delete(event.taskId);
            const worker = this.workers.get(event.workerId);
            worker?.actor.send({
              type: "COMPLETE_PROCESSING",
              taskId: event.taskId,
            });
          }
        },
        broadcastMessage: ({ event }) => {
          if (event.type === "BROADCAST") {
            this.broadcast(event.channel, event.message);
          }
        },
        initiateShutdown: () => {
          logger.info("Initiating WorkerManager shutdown");
          this.shutdownAllWorkers();
        },
      },
    });

    this.actor = createActor(machine);
    this.actor.start();
  }

  spawnWorker(
    metadata: WorkerMetadata,
    url: string,
  ): ManagedWorker {
    const { id, type } = metadata;

    // Create worker with permissions to use BroadcastChannel
    // @ts-ignore - Unstable API
    const worker = new Worker(url, {
      type: "module",
      deno: {
        permissions: "inherit",
      },
    });

    // Create state machine for this worker
    const workerMachine = createWorkerMachine(id, type);
    const workerActor = createActor(workerMachine);
    workerActor.start();

    // Create managed worker instance
    const managedWorker: ManagedWorker = {
      id,
      type,
      worker,
      actor: workerActor,
      ports: new Map(),
      metadata,
    };

    // Setup worker message handling
    worker.onmessage = (event) => {
      logger.trace(`Message from worker`, {
        workerId: id,
        messageType: event.data.type,
      });
      this.handleWorkerMessage(managedWorker, event.data);
    };

    worker.onerror = (error) => {
      logger.error(`Worker error`, { workerId: id, error: error.toString() });
      workerActor.send({ type: "ERROR", error: error.toString() });
    };

    // Store worker
    this.workers.set(id, managedWorker);

    // Notify manager
    this.actor.send({ type: "WORKER_SPAWNED", workerId: id });

    // Initialize worker with faster pattern - send both messages immediately
    workerActor.send({ type: "INITIALIZE", config: metadata.config });
    worker.postMessage({
      type: "init",
      id: metadata.id,
      workerType: metadata.type,
      config: metadata.config,
    });

    return managedWorker;
  }

  private handleWorkerMessage(worker: ManagedWorker, message: any) {
    switch (message.type) {
      case "initialized":
        worker.actor.send({ type: "INITIALIZED" });
        break;
      case "error":
        worker.actor.send({ type: "ERROR", error: message.error });
        break;
      case "result":
        // Update both worker state and manager state
        worker.actor.send({
          type: "COMPLETE_PROCESSING",
          taskId: message.taskId,
          result: message.result,
        });
        this.actor.send({
          type: "TASK_COMPLETED",
          workerId: worker.id,
          taskId: message.taskId,
        });
        break;
      case "shutdown_ack":
        // Worker acknowledged shutdown - this is handled in terminateWorker's Promise.race
        // No action needed here, the event listener in terminateWorker will handle it
        break;
    }
  }

  async terminateWorker(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Send termination signal to worker state machine
    worker.actor.send({ type: "TERMINATE" });

    // Send shutdown message to worker
    worker.worker.postMessage({ type: "shutdown" });

    // Wait for graceful shutdown with proper timeout
    let gracefulShutdown = false;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          const handler = (e: MessageEvent) => {
            if (e.data.type === "shutdown_ack") {
              worker.worker.removeEventListener("message", handler);
              gracefulShutdown = true;
              resolve();
            }
          };
          worker.worker.addEventListener("message", handler);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)), // 5 second timeout
      ]);
    } catch (error) {
      logger.warn(`Worker ${workerId} graceful shutdown failed`, { error });
    }

    if (!gracefulShutdown) {
      logger.warn(`Worker ${workerId} did not shut down gracefully, force terminating`);
    }

    // Force terminate
    worker.worker.terminate();

    // Clean up with error handling
    try {
      worker.ports.forEach((port) => {
        try {
          port.close();
        } catch (_e) { /* ignore */ }
      });
      if (worker.broadcastChannel) {
        try {
          worker.broadcastChannel.close();
        } catch (_e) { /* ignore */ }
      }
      worker.actor.send({ type: "TERMINATED" });
      worker.actor.stop();
    } catch (error) {
      logger.error(`Error during worker cleanup for ${workerId}`, { error });
    }

    this.workers.delete(workerId);
    this.actor.send({ type: "WORKER_TERMINATED", workerId });
  }

  createMessageChannel(workerId1: string, workerId2: string): void {
    const worker1 = this.workers.get(workerId1);
    const worker2 = this.workers.get(workerId2);

    if (!worker1 || !worker2) {
      throw new Error("Workers not found");
    }

    const { port1, port2 } = new MessageChannel();

    worker1.ports.set(workerId2, port1);
    worker2.ports.set(workerId1, port2);

    worker1.worker.postMessage(
      {
        type: "setPort",
        peerId: workerId2,
        port: port1,
      },
      [port1],
    );

    worker2.worker.postMessage(
      {
        type: "setPort",
        peerId: workerId1,
        port: port2,
      },
      [port2],
    );
  }

  setupBroadcastChannel(workerId: string, channelName: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Check if BroadcastChannel is available
    if (typeof BroadcastChannel === "undefined") {
      logger.warn("BroadcastChannel not available, skipping channel setup");
      return;
    }

    worker.broadcastChannel = new BroadcastChannel(channelName);
    worker.worker.postMessage({
      type: "joinChannel",
      channel: channelName,
    });
  }

  broadcast(channel: string, message: any): void {
    // Check if BroadcastChannel is available
    if (typeof BroadcastChannel === "undefined") {
      logger.warn("BroadcastChannel not available, skipping broadcast");
      return;
    }

    const broadcastChannel = new BroadcastChannel(channel);
    broadcastChannel.postMessage(message);
    broadcastChannel.close();
  }

  sendTask(workerId: string, taskId: string, data: any): Promise<any> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = 300000; // Extended to 5 minutes for LLM processing and async operations
      const timeout = setTimeout(() => {
        reject(new Error(`Task ${taskId} timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      // Listen for result
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === "result" && event.data.taskId === taskId) {
          clearTimeout(timeout);
          worker.worker.removeEventListener("message", handleMessage);
          resolve(event.data.result);
        } else if (
          event.data.type === "error" &&
          event.data.taskId === taskId
        ) {
          clearTimeout(timeout);
          worker.worker.removeEventListener("message", handleMessage);
          reject(new Error(event.data.error));
        }
      };

      worker.worker.addEventListener("message", handleMessage);

      // Send task
      worker.worker.postMessage({
        type: "task",
        taskId,
        data,
      });

      // Update worker state (use correct event type)
      worker.actor.send({ type: "START_PROCESSING", taskId });
    });
  }

  async shutdown(): Promise<void> {
    this.actor.send({ type: "SHUTDOWN" });

    // Wait for shutdown to complete with timeout
    const shutdownPromise = new Promise<void>((resolve) => {
      const subscription = this.actor.subscribe((state: any) => {
        if (state.matches("terminated")) {
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error("WorkerManager shutdown timed out after 15 seconds"));
      }, 15000);
    });

    try {
      await Promise.race([shutdownPromise, timeoutPromise]);
      logger.info("WorkerManager shutdown completed gracefully");
    } catch (error) {
      logger.error("WorkerManager shutdown timed out, forcing termination", { error });

      // Force terminate all remaining workers
      for (const [workerId, worker] of this.workers) {
        try {
          worker.worker.terminate();
          this.workers.delete(workerId);
        } catch (_e) {
          // Ignore errors during force termination
        }
      }

      // Stop the actor
      this.actor.stop();
    }
  }

  private async shutdownAllWorkers(): Promise<void> {
    const workerIds = Array.from(this.workers.keys());

    // Terminate all workers in parallel
    await Promise.all(workerIds.map((id) => this.terminateWorker(id)));
  }

  // Utility methods
  getWorker(workerId: string): ManagedWorker | undefined {
    return this.workers.get(workerId);
  }

  getWorkersByType(type: WorkerType): ManagedWorker[] {
    return Array.from(this.workers.values()).filter((w) => w.type === type);
  }

  getWorkerState(workerId: string): WorkerState | undefined {
    const worker = this.workers.get(workerId);
    return worker?.actor.getSnapshot().value as WorkerState;
  }

  isWorkerReady(workerId: string): boolean {
    return this.getWorkerState(workerId) === "ready";
  }

  waitForWorkerReady(workerId: string, timeout = 2000): Promise<boolean> {
    const worker = this.workers.get(workerId);
    if (!worker) return Promise.resolve(false);

    // Check if already ready
    if (worker.actor.getSnapshot().matches("ready")) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => resolve(false), timeout);

      const subscription = worker.actor.subscribe((state: any) => {
        if (state.matches("ready")) {
          clearTimeout(timeoutId);
          subscription.unsubscribe();
          resolve(true);
        }
      });
    });
  }

  /**
   * Common worker creation pattern with timeout and ready check
   * Consolidates duplicated supervisor worker creation logic
   */
  async spawnSupervisorWorker(
    workspaceId: string,
    config: any,
    options: { model?: string; timeout?: number } = {},
  ): Promise<ManagedWorker> {
    const { timeout = 5000 } = options;

    const supervisorMetadata: WorkerMetadata = {
      id: crypto.randomUUID(),
      type: "supervisor",
      config: {
        id: workspaceId,
        workspace: config.workspace,
        config: config.config || {},
        model: options.model || config.config?.model,
      },
    };

    // Spawn supervisor worker
    const supervisor = this.spawnWorker(
      supervisorMetadata,
      new URL("../workers/workspace-supervisor-worker.ts", import.meta.url).href,
    );

    // Setup broadcast channel immediately after worker creation
    this.setupBroadcastChannel(supervisor.id, `workspace-${workspaceId}`);

    // Wait for supervisor to be ready
    const ready = await this.waitForWorkerReady(supervisor.id, timeout);

    if (!ready) {
      const state = this.getWorkerState(supervisor.id);
      await this.terminateWorker(supervisor.id);
      throw new Error(`Supervisor failed to initialize within ${timeout}ms (state: ${state})`);
    }

    return supervisor;
  }

  /**
   * Common session worker creation pattern
   * Consolidates duplicated session worker creation logic
   */
  async spawnSessionWorker(
    sessionId: string,
    workspaceId: string,
    config: any,
    _options: { timeout?: number } = {},
  ): Promise<ManagedWorker> {
    // Use worker pool for much faster session creation
    const sessionWorker = await this.getPooledWorker(
      "session",
      new URL("../workers/session-supervisor-worker.ts", import.meta.url).href,
      {
        sessionId,
        workspaceId,
        ...config,
      },
    );

    return sessionWorker;
  }

  /**
   * Common agent worker creation pattern
   * Consolidates duplicated agent worker creation logic
   */
  async spawnAgentWorker(
    agentId: string,
    agentConfig: any,
    sessionId: string,
    options: { timeout?: number } = {},
  ): Promise<ManagedWorker> {
    const { timeout = 5000 } = options;

    const agentMetadata: WorkerMetadata = {
      id: crypto.randomUUID(),
      type: "agent",
      config: {
        agentId,
        sessionId,
        ...agentConfig,
      },
    };

    // Spawn agent worker
    const agentWorker = this.spawnWorker(
      agentMetadata,
      new URL("../workers/agent-worker.ts", import.meta.url).href,
    );

    // Wait for agent worker to be ready
    const ready = await this.waitForWorkerReady(agentWorker.id, timeout);

    if (!ready) {
      const state = this.getWorkerState(agentWorker.id);
      await this.terminateWorker(agentWorker.id);
      throw new Error(`Agent worker failed to initialize within ${timeout}ms (state: ${state})`);
    }

    return agentWorker;
  }

  /**
   * Standard error handling for worker operations
   * Consolidates error logging and cleanup patterns
   */
  async handleWorkerError(workerId: string, error: Error | string, context?: any): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : error;
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error(`Worker error: ${errorMessage}`, {
      workerId: workerId.slice(0, 8),
      workerType: this.getWorkerType(workerId),
      error: errorMessage,
      stack: errorStack,
      ...context,
    });

    // Attempt graceful cleanup
    try {
      await this.terminateWorker(workerId);
    } catch (cleanupError) {
      logger.error(`Failed to cleanup worker after error`, {
        workerId: workerId.slice(0, 8),
        cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  /**
   * Get worker type by ID
   */
  private getWorkerType(workerId: string): WorkerType | "unknown" {
    const worker = this.workers.get(workerId);
    return worker?.type || "unknown";
  }

  /**
   * Get or create a worker from the pool (primary performance optimization)
   */
  async getPooledWorker(
    type: WorkerType,
    workerUrl: string,
    config?: any,
  ): Promise<ManagedWorker> {
    const pool = this.pools.get(type);
    if (!pool) {
      throw new Error(`No pool configured for worker type: ${type}`);
    }

    // Try to reuse an available worker from the pool
    if (pool.available.length > 0) {
      const worker = pool.available.pop()!;

      // Reset worker for new task
      await this.resetWorker(worker, config);

      pool.inUse.set(worker.id, worker);
      return worker;
    }

    // If no available workers and under max size, create new worker
    if (pool.inUse.size < pool.maxSize) {
      const metadata: WorkerMetadata = {
        id: crypto.randomUUID(),
        type,
        config,
      };

      const worker = this.spawnWorker(metadata, workerUrl);
      pool.inUse.set(worker.id, worker);
      return worker;
    }

    // Pool is at capacity, wait for a worker to become available
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${type} worker from pool`));
      }, 10000);

      const checkForAvailable = () => {
        if (pool.available.length > 0) {
          clearTimeout(timeout);
          const worker = pool.available.pop()!;
          this.resetWorker(worker, config).then(() => {
            pool.inUse.set(worker.id, worker);
            resolve(worker);
          }).catch(reject);
        } else {
          setTimeout(checkForAvailable, 100);
        }
      };

      checkForAvailable();
    });
  }

  /**
   * Return worker to pool when task is complete
   */
  returnWorkerToPool(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    const pool = this.pools.get(worker.type);
    if (!pool) return;

    // Move from inUse to available
    pool.inUse.delete(workerId);
    pool.available.push(worker);
  }

  /**
   * Reset worker state for reuse
   */
  private async resetWorker(worker: ManagedWorker, config?: any): Promise<void> {
    // Reset worker state machine to ready
    worker.actor.send({ type: "INITIALIZE", config });

    // Send new config to worker
    worker.worker.postMessage({
      type: "init",
      id: worker.id,
      workerType: worker.type,
      config,
    });

    // Wait for ready state
    await this.waitForWorkerReady(worker.id, 2000);
  }

  /**
   * Pre-warm worker pools for better performance
   */
  async preWarmPools(): Promise<void> {
    const warmupTasks = [];

    // Pre-create some workers for each type
    warmupTasks.push(
      this.preWarmPool(
        "session",
        2,
        new URL("../workers/session-supervisor-worker.ts", import.meta.url).href,
      ),
    );
    warmupTasks.push(
      this.preWarmPool(
        "supervisor",
        1,
        new URL("../workers/workspace-supervisor-worker.ts", import.meta.url).href,
      ),
    );

    await Promise.all(warmupTasks);
  }

  private async preWarmPool(type: WorkerType, count: number, workerUrl: string): Promise<void> {
    const pool = this.pools.get(type);
    if (!pool) return;

    const tasks = [];
    for (let i = 0; i < count; i++) {
      const metadata: WorkerMetadata = {
        id: crypto.randomUUID(),
        type,
        config: {},
      };

      tasks.push(
        Promise.resolve(this.spawnWorker(metadata, workerUrl)).then((worker) => {
          pool.available.push(worker);
        }),
      );
    }

    await Promise.all(tasks);
    logger.info(`Pre-warmed ${count} ${type} workers`);
  }
}
