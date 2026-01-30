/**
 * Codegen Execution
 *
 * Executes TypeScript code that uses FSMBuilder API via isolated Web Worker.
 * Returns the Result<FSMDefinition, BuildError[]> from the code.
 *
 * Benefits over previous dynamic import approach:
 * - No file system access (pure in-memory)
 * - Better isolation (worker with zero permissions)
 * - No import management needed
 * - Cleaner and more secure
 */

import { z } from "zod";
import type { BuildError, FSMDefinition, Result } from "../types.ts";

// Schema to validate Result shape from worker
const ResultSchema = z.union([
  z.object({
    success: z.literal(true),
    value: z.unknown(), // FSMDefinition shape validation done by FSM engine
  }),
  z.object({
    success: z.literal(false),
    error: z.array(z.unknown()), // BuildError[] shape
  }),
]);

const CodegenInputSchema = z.object({
  code: z.string().describe("TypeScript code that uses FSMBuilder API"),
  timeout: z
    .number()
    .optional()
    .default(30000)
    .describe("Execution timeout in milliseconds (default: 30000)"),
});

type CodegenInput = z.infer<typeof CodegenInputSchema>;

interface CodegenError {
  type: "invalid_export" | "execution_error" | "timeout";
  message: string;
  stack?: string;
}

type CodegenResult =
  | { success: true; result: Result<FSMDefinition, BuildError[]> }
  | { success: false; error: CodegenError };

/** Node-style Worker API (used by compiled Deno) */
interface NodeWorker extends Worker {
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error" | "messageerror", listener: (error: Error | ErrorEvent) => void): void;
}

function hasNodeWorkerApi(worker: Worker): worker is NodeWorker {
  return typeof (worker as NodeWorker).on === "function";
}

/**
 * Execute TypeScript code that builds FSM via Web Worker
 */
export function executeCodegen(input: CodegenInput): Promise<CodegenResult> {
  const { code, timeout } = input;

  // Create isolated worker
  const workerUrl = new URL("./codegen.worker.ts", import.meta.url).href;

  const worker = new Worker(workerUrl, {
    type: "module",
    deno: {
      permissions: "none", // Complete isolation - no file, net, env access
    },
  });

  // Generate unique request ID for message correlation
  const requestId = crypto.randomUUID();

  // Setup timeout and message handling
  return new Promise<CodegenResult>((resolve) => {
    const overallTimeoutId = setTimeout(() => {
      worker.terminate();
      resolve({
        success: false,
        error: { type: "timeout", message: `Worker timed out after ${timeout}ms` },
      });
    }, timeout + 1000); // Give worker slightly more time than its internal timeout

    const handleMessage = (rawData: unknown) => {
      clearTimeout(overallTimeoutId);

      // Parse JSON string response
      // NodeWorker .on('message') receives data directly (not wrapped in MessageEvent)
      let data: { requestId: string; success: boolean; result?: unknown; error?: unknown };
      try {
        if (typeof rawData === "string") {
          data = JSON.parse(rawData) as {
            requestId: string;
            success: boolean;
            result?: unknown;
            error?: unknown;
          };
        } else {
          data = rawData as {
            requestId: string;
            success: boolean;
            result?: unknown;
            error?: unknown;
          };
        }
      } catch (parseError) {
        worker.terminate();
        resolve({
          success: false,
          error: {
            type: "execution_error",
            message: `Failed to parse worker response: ${parseError}`,
          },
        });
        return;
      }

      // Verify this is our response (not a test message or other data)
      if (!data.requestId || data.requestId !== requestId) {
        // Ignore non-matching messages (might be test messages)
        return;
      }

      if (data.success) {
        // Validate Result shape with Zod
        const parseResult = ResultSchema.safeParse(data.result);

        if (!parseResult.success) {
          worker.terminate();
          resolve({
            success: false,
            error: {
              type: "invalid_export",
              message:
                "Worker returned invalid Result object. " +
                `Expected Result from builder.build(), got: ${JSON.stringify(data.result)}`,
            },
          });
          return;
        }

        worker.terminate();
        resolve({ success: true, result: parseResult.data as Result<FSMDefinition, BuildError[]> });
      } else {
        // Worker reported error
        worker.terminate();
        resolve({ success: false, error: data.error as CodegenError });
      }
    };

    const handleError = (error: Error | ErrorEvent) => {
      clearTimeout(overallTimeoutId);
      worker.terminate();
      const errorMsg = error instanceof Error ? error.message : (error as ErrorEvent).message;
      resolve({
        success: false,
        error: { type: "execution_error", message: `Worker error: ${errorMsg || String(error)}` },
      });
    };

    const handleMessageError = (error: Error | ErrorEvent) => {
      clearTimeout(overallTimeoutId);
      worker.terminate();
      const errorMsg = error instanceof Error ? error.message : (error as ErrorEvent).message;
      resolve({
        success: false,
        error: {
          type: "execution_error",
          message: `Message deserialization error: ${errorMsg || String(error)}`,
        },
      });
    };

    // Support both NodeWorker (.on) and standard Web Worker (onmessage) APIs
    if (hasNodeWorkerApi(worker)) {
      worker.on("message", handleMessage);
      worker.on("error", handleError);
      worker.on("messageerror", handleMessageError);
    } else {
      worker.onmessage = (event: MessageEvent) => handleMessage(event.data);
      worker.onerror = handleError;
      worker.onmessageerror = (event: MessageEvent) =>
        handleMessageError(new Error(`Message deserialization failed: ${String(event.data)}`));
    }

    // Send code to worker for execution
    worker.postMessage({ requestId, code, timeout });
  });
}
