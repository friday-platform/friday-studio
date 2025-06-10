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

// WorkerManager utility class
export class WorkerManager {
  private actor: any;
  private workers: Map<string, ManagedWorker> = new Map();

  constructor() {
    const machine = createWorkerManagerMachine().provide({
      actions: {
        spawnWorker: ({ context, event }) => {
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
        terminateWorker: ({ context, event }) => {
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

  async spawnWorker(
    metadata: WorkerMetadata,
    url: string,
  ): Promise<ManagedWorker> {
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

    // Initialize worker
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
        this.actor.send({
          type: "TASK_COMPLETED",
          workerId: worker.id,
          taskId: message.taskId,
        });
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

    // Wait a bit for graceful shutdown
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Force terminate
    worker.worker.terminate();

    // Clean up
    worker.ports.forEach((port) => port.close());
    worker.broadcastChannel?.close();
    worker.actor.send({ type: "TERMINATED" });
    worker.actor.stop();

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

  async sendTask(workerId: string, taskId: string, data: any): Promise<any> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Task ${taskId} timeout`));
      }, 60000);

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

      // Update worker state
      worker.actor.send({ type: "PROCESS_TASK", taskId });
    });
  }

  async shutdown(): Promise<void> {
    this.actor.send({ type: "SHUTDOWN" });

    // Wait for shutdown to complete
    await new Promise<void>((resolve) => {
      this.actor.subscribe((state: any) => {
        if (state.matches("terminated")) {
          resolve();
        }
      });
    });
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

  async waitForWorkerReady(workerId: string, timeout = 5000): Promise<boolean> {
    const worker = this.workers.get(workerId);
    if (!worker) return false;

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
}
