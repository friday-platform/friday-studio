/**
 * WorkerExecutor - Sandboxed execution of FSM functions in Deno Web Workers
 *
 * Spawns zero-permission workers for guards, actions, and tools.
 * Collects mutations from worker, applies them after execution.
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
}

interface WorkerRequest {
  requestId: string;
  functionCode: string;
  contextData: { documents: Document[]; state: string };
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

export class WorkerExecutor {
  private readonly timeout: number;
  private readonly functionType: string;
  private readonly permissions: Deno.PermissionOptions;

  constructor(options: WorkerExecutorOptions) {
    this.timeout = options.timeout;
    this.functionType = options.functionType;
    this.permissions = options.permissions ?? "none";
  }

  execute(
    functionCode: string,
    functionName: string,
    context: Context,
    signal: Signal,
  ): Promise<unknown> {
    const workerUrl = new URL("./function-executor.worker.ts", import.meta.url).href;
    const worker = new Worker(workerUrl, {
      type: "module",
      deno: { permissions: this.permissions },
    });

    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        worker.terminate();
        reject(
          new Error(`${this.functionType} '${functionName}' timed out after ${this.timeout}ms`),
        );
      }, this.timeout + 1000);

      const handleMessage = (rawData: unknown) => {
        const parsed = WorkerResponseSchema.safeParse(
          typeof rawData === "string" ? JSON.parse(rawData) : rawData,
        );

        if (!parsed.success) {
          clearTimeout(timeoutId);
          worker.terminate();
          reject(new Error(`Invalid worker response: ${parsed.error.message}`));
          return;
        }

        const response = parsed.data;
        if (response.requestId !== requestId) return;

        clearTimeout(timeoutId);
        worker.terminate();

        if (!response.success) {
          const errorMsg = response.stack ? `${response.error}\n${response.stack}` : response.error;
          reject(new Error(errorMsg));
          return;
        }

        // Apply mutations to real context
        if (response.mutations) {
          this.applyMutations(response.mutations, context);
        }

        resolve(response.result);
      };

      const handleError = (error: Error | ErrorEvent) => {
        clearTimeout(timeoutId);
        worker.terminate();
        const errorMsg = error instanceof Error ? error.message : (error as ErrorEvent).message;
        reject(new Error(`Worker error: ${stringifyError(errorMsg)}`));
      };

      // Support both NodeWorker (.on) and standard Web Worker (onmessage) APIs
      // NodeWorker is used by compiled Deno, Web Worker by deno test
      if (hasNodeWorkerApi(worker)) {
        // NodeWorker API (compiled Deno)
        worker.on("message", handleMessage);
        worker.on("error", handleError);
        worker.on("messageerror", handleError);
      } else {
        // Standard Web Worker API (deno test)
        worker.onmessage = (event: MessageEvent) => handleMessage(event.data);
        worker.onerror = handleError;
      }

      const request: WorkerRequest = {
        requestId,
        functionCode,
        contextData: { documents: context.documents, state: context.state },
        signal,
        timeout: this.timeout,
      };
      worker.postMessage(JSON.stringify(request));
    });
  }

  private applyMutations(mutations: Mutation[], context: Context): void {
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
      }
    }
  }
}
