/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />
/// <reference lib="deno.unstable" />

import { assign, createActor, createMachine, fromPromise } from "xstate";
import { type ChildLogger, logger } from "../../utils/logger.ts";

// Base worker states
export type BaseWorkerState =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "busy"
  | "error"
  | "shutting_down"
  | "terminated";

// Base worker events
export type BaseWorkerEvent =
  | { type: "INIT"; config: any }
  | { type: "INIT_SUCCESS" }
  | { type: "INIT_ERROR"; error: string }
  | { type: "TASK"; taskId: string; data: any }
  | { type: "TASK_COMPLETE"; taskId: string; result?: any }
  | { type: "TASK_ERROR"; taskId: string; error: string }
  | { type: "JOIN_CHANNEL"; channel: string }
  | { type: "SET_PORT"; peerId: string; port: MessagePort }
  | { type: "SHUTDOWN" }
  | { type: "CLEANUP_COMPLETE" };

// Base worker context
export interface BaseWorkerContext {
  id: string;
  type: string;
  config?: any;
  error?: string;
  currentTask?: string;
  channels: Set<string>;
  ports: Map<string, MessagePort>;
  broadcastChannels: Map<string, BroadcastChannel>;
}

// Create base worker state machine
export function createBaseWorkerMachine(id: string, type: string) {
  return createMachine({
    id: `worker-${id}`,
    initial: "uninitialized",
    context: {
      id,
      type,
      channels: new Set(),
      ports: new Map(),
      broadcastChannels: new Map(),
    } as BaseWorkerContext,
    states: {
      uninitialized: {
        on: {
          INIT: {
            target: "initializing",
            actions: [
              assign({
                config: ({ event }) => event.config,
              }),
            ],
          },
        },
      },
      initializing: {
        invoke: {
          id: "initialize",
          src: "performInitialization",
          input: ({ context }) => ({ config: context.config }),
          onDone: {
            target: "ready",
            actions: "notifyInitialized",
          },
          onError: {
            target: "error",
            actions: [
              assign({
                error: ({ event }) => String(event.error),
              }),
            ],
          },
        },
      },
      ready: {
        on: {
          TASK: {
            target: "busy",
            actions: assign({
              currentTask: ({ event }) => event.taskId,
            }),
          },
          JOIN_CHANNEL: {
            actions: "joinBroadcastChannel",
          },
          SET_PORT: {
            actions: "setupMessagePort",
          },
          SHUTDOWN: {
            target: "shutting_down",
          },
        },
      },
      busy: {
        invoke: {
          id: "processTask",
          src: "performTask",
          input: ({ event, context }) => ({
            taskId: context.currentTask,
            data: event.type === "TASK" ? event.data : undefined,
          }),
          onDone: {
            target: "ready",
            actions: ["notifyTaskComplete", assign({ currentTask: undefined })],
          },
          onError: {
            target: "ready",
            actions: ["notifyTaskError", assign({ currentTask: undefined })],
          },
        },
        on: {
          SHUTDOWN: {
            target: "shutting_down",
          },
        },
      },
      error: {
        on: {
          INIT: {
            target: "initializing",
            actions: assign({
              error: undefined,
            }),
          },
          SHUTDOWN: {
            target: "shutting_down",
          },
        },
      },
      shutting_down: {
        invoke: {
          id: "cleanup",
          src: "performCleanup",
          onDone: {
            target: "terminated",
          },
        },
      },
      terminated: {
        type: "final",
        entry: () => self.close(),
      },
    },
  });
}

// Base worker class that specific workers can extend
export abstract class BaseWorker<
  TContext extends BaseWorkerContext = BaseWorkerContext,
> {
  protected actor: any;
  protected context: TContext;
  protected logger: ChildLogger;

  constructor(id: string, type: string) {
    this.context = {
      id,
      type,
      channels: new Set(),
      ports: new Map(),
      broadcastChannels: new Map(),
    } as TContext;

    // Create child logger for this worker
    this.logger = logger.createChildLogger({
      workerId: id,
      workerType: type,
    });

    const machine = createBaseWorkerMachine(id, type).provide({
      actions: {
        notifyInitialized: () => {
          self.postMessage({ type: "initialized" });
        },
        notifyTaskComplete: ({ context, event }) => {
          self.postMessage({
            type: "result",
            taskId: context.currentTask,
            result: event.output,
          });
        },
        notifyTaskError: ({ context, event }) => {
          if (event.type === "error.platform.processTask") {
            self.postMessage({
              type: "error",
              taskId: context.currentTask,
              error: event.error,
            });
          }
        },
        joinBroadcastChannel: ({ context, event }) => {
          if (event.type === "JOIN_CHANNEL") {
            // Disable BroadcastChannel in workers due to Tokio runtime conflicts
            context.channels.add(event.channel);
          }
        },
        setupMessagePort: ({ context, event }) => {
          if (event.type === "SET_PORT") {
            context.ports.set(event.peerId, event.port);
            event.port.onmessage = (e: MessageEvent) =>
              this.handleDirectMessage(event.peerId, e.data);
          }
        },
      },
      actors: {
        performInitialization: fromPromise(async ({ input }) => {
          await this.initialize(input.config);
        }),
        performTask: fromPromise(async ({ input }) => {
          const { taskId, data } = input;
          return await this.processTask(taskId, data);
        }),
        performCleanup: fromPromise(async () => {
          await this.cleanup();

          // Close all channels and ports
          this.context.ports.forEach((port) => port.close());
        }),
      },
    });

    this.actor = createActor(machine);
    this.actor.start();

    // Setup message handler
    self.onmessage = (event) => this.handleMessage(event.data);
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case "init":
        this.context.config = message.config;
        this.actor.send({ type: "INIT", config: message.config });
        break;
      case "shutdown":
        this.actor.send({ type: "SHUTDOWN" });
        // Send acknowledgment back to manager
        self.postMessage({ type: "shutdown_ack" });
        break;
      case "joinChannel":
        this.actor.send({ type: "JOIN_CHANNEL", channel: message.channel });
        break;
      case "setPort":
        this.actor.send({
          type: "SET_PORT",
          peerId: message.peerId,
          port: message.port,
        });
        break;
      case "task":
        this.actor.send({
          type: "TASK",
          taskId: message.taskId,
          data: message.data,
        });
        break;
      default:
        // Let subclasses handle other messages
        this.handleCustomMessage(message);
    }
  }

  // Abstract methods that subclasses must implement
  protected abstract initialize(config: any): Promise<void>;
  protected abstract processTask(taskId: string, data: any): Promise<any>;
  protected abstract cleanup(): Promise<void>;

  // Optional methods that subclasses can override
  protected handleCustomMessage(message: any): void {
    this.logger.warn(`Unhandled message received`, {
      messageType: message.type,
      workerType: this.context.type,
    });
  }

  protected handleBroadcast(channel: string, data: any): void {
    this.logger.debug(`Broadcast message received`, {
      channel,
      dataType: data.type,
      workerType: this.context.type,
    });
  }

  protected handleDirectMessage(peerId: string, data: any): void {
    this.logger.debug(`Direct message received`, {
      peerId,
      dataType: data.type,
      workerType: this.context.type,
    });
  }

  // Utility methods for workers
  protected broadcast(channel: string, message: any): void {
    // BroadcastChannel disabled in workers due to Tokio runtime conflicts
    // Note: Broadcast functionality disabled in worker context
  }

  protected sendDirect(peerId: string, message: any): void {
    const port = this.context.ports.get(peerId);
    if (port) {
      port.postMessage(message);
    }
  }

  protected log(...args: any[]): void {
    const message = args
      .map((arg) => typeof arg === "object" ? JSON.stringify(arg) : String(arg))
      .join(" ");
    this.logger.info(message);
  }
}
