/**
 * Sandboxed worker pool for validating transform expressions against mock data.
 *
 * Lazily spawns a zero-permission Deno worker on first execute() call.
 * Queues concurrent requests and processes them sequentially. Call dispose()
 * to terminate the worker when done.
 */

import { z } from "zod";

/** Node-style Worker API (used by compiled Deno) */
interface NodeWorker extends Worker {
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error" | "messageerror", listener: (error: Error | ErrorEvent) => void): void;
}

function hasNodeWorkerApi(worker: Worker): worker is NodeWorker {
  return typeof (worker as NodeWorker).on === "function";
}

interface ExecuteParams {
  expression: string;
  mockValue: unknown;
  mockDocs: Record<string, unknown>;
  timeout?: number;
}

type ExecuteResult = { success: true; result: unknown } | { success: false; error: string };

const WorkerResponseSchema = z.object({
  requestId: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const DEFAULT_TIMEOUT = 5000;

export class ValidationExecutor {
  private worker: Worker | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  /**
   * Evaluate a transform expression in a sandboxed worker.
   *
   * @param params - Expression string, mock value/docs for bindings, optional timeout
   * @returns Success with result or failure with error message
   */
  execute(params: ExecuteParams): Promise<ExecuteResult> {
    if (this.disposed) {
      return Promise.resolve({ success: false, error: "ValidationExecutor has been disposed" });
    }

    const result = new Promise<ExecuteResult>((resolve) => {
      this.queue = this.queue.then(() => this.run(params, resolve));
    });

    return result;
  }

  /** Terminate the worker. Subsequent execute() calls return an error. */
  dispose(): void {
    this.disposed = true;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const workerUrl = new URL("./validation.worker.ts", import.meta.url).href;
      this.worker = new Worker(workerUrl, { type: "module", deno: { permissions: "none" } });
    }
    return this.worker;
  }

  private run(params: ExecuteParams, resolve: (result: ExecuteResult) => void): Promise<void> {
    return new Promise<void>((done) => {
      if (this.disposed) {
        resolve({ success: false, error: "ValidationExecutor has been disposed" });
        done();
        return;
      }

      const worker = this.ensureWorker();
      const requestId = crypto.randomUUID();
      const timeout = params.timeout ?? DEFAULT_TIMEOUT;

      const timeoutId = setTimeout(() => {
        cleanup();
        resolve({ success: false, error: `Timeout after ${timeout}ms` });
        done();
      }, timeout + 500); // Extra buffer beyond worker's internal timeout

      const cleanup = () => {
        clearTimeout(timeoutId);
      };

      const handleMessage = (rawData: unknown) => {
        const raw = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
        const parsed = WorkerResponseSchema.safeParse(raw);
        if (!parsed.success) return; // Not our message

        const data = parsed.data;
        if (data.requestId !== requestId) return;

        cleanup();
        if (data.success) {
          resolve({ success: true, result: data.result });
        } else {
          resolve({ success: false, error: data.error ?? "Unknown worker error" });
        }
        done();
      };

      const handleError = (error: Error | ErrorEvent) => {
        cleanup();
        resolve({ success: false, error: `Worker error: ${error.message}` });
        // Worker is dead — null it so ensureWorker() doesn't reuse a dead reference
        this.worker = null;
        done();
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

      worker.postMessage(
        JSON.stringify({
          requestId,
          expression: params.expression,
          mockValue: params.mockValue,
          mockDocs: params.mockDocs,
          timeout,
        }),
      );
    });
  }
}
