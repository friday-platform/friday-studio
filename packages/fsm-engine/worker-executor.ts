/**
 * WorkerExecutor - Sandboxed execution of FSM functions in Deno Web Workers
 *
 * Maintains a pool of warm workers to eliminate per-invocation spawn cost.
 * Workers are stateless between calls — all state is serialized per request.
 */

import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import type { Context, Document, Signal } from "./types.ts";

const DocumentSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const SignalSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

interface WorkerExecutorOptions {
  timeout: number;
  functionType: "guard" | "action" | "tool";
  permissions?: Deno.PermissionOptions;
  /** Max idle workers to keep warm. Defaults to 1. */
  poolSize?: number;
}

interface WorkerRequest {
  requestId: string;
  functionCode: string;
  contextData: {
    documents: Document[];
    state: string;
    results: Record<string, Record<string, unknown>>;
  };
  signal: Signal;
  timeout: number;
}

const MutationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("updateDoc"),
    args: z.tuple([z.string(), z.record(z.string(), z.unknown())]),
  }),
  z.object({ op: z.literal("createDoc"), args: z.tuple([DocumentSchema]) }),
  z.object({ op: z.literal("deleteDoc"), args: z.tuple([z.string()]) }),
  z.object({ op: z.literal("emit"), args: z.tuple([SignalSchema]) }),
  z.object({
    op: z.literal("setResult"),
    args: z.tuple([z.string(), z.record(z.string(), z.unknown())]),
  }),
  z.object({
    op: z.literal("stateAppend"),
    args: z.tuple([z.string(), z.record(z.string(), z.unknown()), z.number().optional()]),
  }),
]);

type Mutation = z.infer<typeof MutationSchema>;

const WorkerResponseSchema = z.object({
  requestId: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
  mutations: z.array(MutationSchema).optional(),
  error: z.string().optional(),
  stack: z.string().optional(),
});

/** Node-style Worker API (used by compiled Deno) */
interface NodeWorker extends Worker {
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error" | "messageerror", listener: (error: Error | ErrorEvent) => void): void;
}

function hasNodeWorkerApi(worker: Worker): worker is NodeWorker {
  return typeof (worker as NodeWorker).on === "function";
}

interface PendingRequest {
  context: Context;
  functionName: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  worker: Worker;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

export class WorkerExecutor {
  private readonly timeout: number;
  private readonly functionType: string;
  private readonly permissions: Deno.PermissionOptions;
  private readonly poolSize: number;

  /** Workers ready for the next request. */
  private readonly idle: Worker[] = [];
  /** In-flight requests keyed by requestId. */
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: WorkerExecutorOptions) {
    this.timeout = options.timeout;
    this.functionType = options.functionType;
    this.permissions = options.permissions ?? "none";
    this.poolSize = options.poolSize ?? 1;
  }

  private spawnWorker(): Worker {
    const workerUrl = new URL("./function-executor.worker.ts", import.meta.url).href;
    const worker = new Worker(workerUrl, {
      type: "module",
      deno: { permissions: this.permissions },
    });

    const handleMessage = (rawData: unknown) => {
      const parsed = WorkerResponseSchema.safeParse(
        typeof rawData === "string" ? JSON.parse(rawData) : rawData,
      );
      if (!parsed.success) return;

      const entry = this.pending.get(parsed.data.requestId);
      if (!entry || entry.worker !== worker) return;

      clearTimeout(entry.timeoutId);
      this.pending.delete(parsed.data.requestId);
      if (entry.abortListener) {
        entry.abortSignal?.removeEventListener("abort", entry.abortListener);
      }

      if (!parsed.data.success) {
        const errorMsg = parsed.data.stack
          ? `${parsed.data.error}\n${parsed.data.stack}`
          : parsed.data.error;
        entry.reject(new Error(errorMsg));
      } else {
        try {
          if (parsed.data.mutations) {
            this.applyMutations(parsed.data.mutations, entry.context);
          }
          entry.resolve(parsed.data.result);
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }

      this.releaseWorker(worker);
    };

    const handleError = (error: Error | ErrorEvent) => {
      for (const [requestId, entry] of this.pending) {
        if (entry.worker !== worker) continue;
        clearTimeout(entry.timeoutId);
        this.pending.delete(requestId);
        if (entry.abortListener) {
          entry.abortSignal?.removeEventListener("abort", entry.abortListener);
        }
        const msg = error instanceof Error ? error.message : (error as ErrorEvent).message;
        entry.reject(new Error(`Worker error: ${stringifyError(msg)}`));
        break;
      }
      worker.terminate();
    };

    if (hasNodeWorkerApi(worker)) {
      worker.on("message", handleMessage);
      worker.on("error", handleError);
      worker.on("messageerror", handleError);
    } else {
      worker.onmessage = (event: MessageEvent) => handleMessage(event.data);
      worker.onerror = handleError;
      worker.onmessageerror = (event: MessageEvent) =>
        handleError(new Error(`Message deserialization failed: ${String(event.data)}`));
    }

    return worker;
  }

  private acquireWorker(): Worker {
    return this.idle.pop() ?? this.spawnWorker();
  }

  private releaseWorker(worker: Worker): void {
    if (this.idle.length < this.poolSize) {
      this.idle.push(worker);
    } else {
      worker.terminate();
    }
  }

  /** Terminate the worker and spawn a replacement to keep the pool warm. */
  private discardAndReplenish(worker: Worker): void {
    worker.terminate();
    if (this.idle.length < this.poolSize) {
      try {
        this.idle.push(this.spawnWorker());
      } catch {
        // Non-fatal: pool will replenish on next execute() if spawn fails here.
      }
    }
  }

  execute(
    functionCode: string,
    functionName: string,
    context: Context,
    signal: Signal,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    if (abortSignal?.aborted) {
      return Promise.reject(new Error(`${this.functionType} '${functionName}' was cancelled`));
    }

    const requestId = crypto.randomUUID();
    let worker: Worker;
    try {
      worker = this.acquireWorker();
    } catch (error) {
      return Promise.reject(
        new Error(
          `Worker creation failed for ${this.functionType} '${functionName}': ${stringifyError(error)}`,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        this.discardAndReplenish(worker);
        reject(
          new Error(`${this.functionType} '${functionName}' timed out after ${this.timeout}ms`),
        );
      }, this.timeout + 1000);

      let abortListener: (() => void) | undefined;
      if (abortSignal) {
        abortListener = () => {
          const entry = this.pending.get(requestId);
          if (!entry) return; // Already resolved/rejected
          clearTimeout(entry.timeoutId);
          this.pending.delete(requestId);
          this.discardAndReplenish(worker);
          reject(new Error(`${this.functionType} '${functionName}' was cancelled`));
        };
        abortSignal.addEventListener("abort", abortListener, { once: true });
      }

      this.pending.set(requestId, {
        context,
        functionName,
        resolve,
        reject,
        timeoutId,
        worker,
        abortSignal,
        abortListener,
      });

      const request: WorkerRequest = {
        requestId,
        functionCode,
        contextData: {
          documents: context.documents,
          state: context.state,
          results: context.results,
        },
        signal,
        timeout: this.timeout,
      };
      worker.postMessage(JSON.stringify(request));
    });
  }

  /** Terminate all idle workers. Call when the workspace runtime shuts down. */
  dispose(): void {
    for (const worker of this.idle) {
      worker.terminate();
    }
    this.idle.length = 0;
  }

  private applyMutations(mutations: Mutation[], context: Context): void {
    const pendingAppends: Array<{
      key: string;
      entry: Record<string, unknown>;
      ttlHours?: number;
    }> = [];

    for (const mutation of mutations) {
      switch (mutation.op) {
        case "updateDoc":
          context.updateDoc?.(mutation.args[0], mutation.args[1]);
          break;
        case "createDoc":
          context.createDoc?.(mutation.args[0]);
          break;
        case "deleteDoc":
          context.deleteDoc?.(mutation.args[0]);
          break;
        case "emit":
          context.emit?.(mutation.args[0]);
          break;
        case "setResult":
          context.setResult?.(mutation.args[0], mutation.args[1]);
          break;
        case "stateAppend":
          pendingAppends.push({
            key: mutation.args[0],
            entry: mutation.args[1],
            ttlHours: mutation.args[2],
          });
          break;
      }
    }

    if (pendingAppends.length > 0) {
      context.setResult?.("__pendingStateAppends", { items: pendingAppends });
    }
  }
}
