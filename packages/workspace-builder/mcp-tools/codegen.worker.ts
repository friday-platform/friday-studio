/**
 * Codegen Worker
 *
 * Executes LLM-generated FSMBuilder code in isolated Web Worker context.
 * Provides FSMBuilder API in function scope without requiring imports.
 *
 * Benefits:
 * - No file system access required
 * - Pure in-memory execution
 * - Better isolation with zero permissions
 * - Simpler LLM contract (no import management)
 */

import { stringifyError } from "@atlas/utils";
import { FSMBuilder } from "../builder.ts";
import { agentAction, codeAction, emitAction, llmAction } from "../helpers.ts";
import type { BuildError, FSMDefinition, Result } from "../types.ts";

interface WorkerRequest {
  requestId: string;
  code: string;
  timeout: number;
}

interface WorkerSuccessResponse {
  requestId: string;
  success: true;
  result: Result<FSMDefinition, BuildError[]>;
}

interface WorkerErrorResponse {
  requestId: string;
  success: false;
  error: {
    type: "invalid_export" | "execution_error" | "timeout";
    message: string;
    stack?: string;
  };
}

/**
 * Worker message handler
 * Receives code from main thread, executes it, returns result
 *
 * Note: Despite Deno docs showing self.onmessage, Deno workers don't have self defined
 * Use bare onmessage and postMessage in global scope
 */
// biome-ignore lint/suspicious/noGlobalAssign: onmessage is the standard Web Worker message handler pattern
onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { requestId, code, timeout } = e.data;

  try {
    // Execute user code with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const result = await executeUserCode(code);

      clearTimeout(timeoutId);

      // Validate result is a Result object
      if (!result || typeof result !== "object") {
        const response: WorkerErrorResponse = {
          requestId,
          success: false,
          error: {
            type: "invalid_export",
            message:
              `Code must set 'result' variable to builder.build() output. ` +
              `Expected Result object, got: ${JSON.stringify(result)}`,
          },
        };
        postMessage(JSON.stringify(response));
        return;
      }

      if (!("success" in result)) {
        const response: WorkerErrorResponse = {
          requestId,
          success: false,
          error: {
            type: "invalid_export",
            message:
              `Code must set 'result' variable to builder.build() output. ` +
              `Expected Result object with 'success' property, got: ${JSON.stringify(result)}`,
          },
        };
        postMessage(JSON.stringify(response));
        return;
      }

      // Send validated result back to main thread
      // Serialize to JSON and back to ensure structured clone compatibility
      // FSMDefinition may contain functions that can't be cloned
      let cleanResult: Result<FSMDefinition, BuildError[]>;
      try {
        const serialized = JSON.stringify(result);
        cleanResult = JSON.parse(serialized) as Result<FSMDefinition, BuildError[]>;
      } catch (jsonError) {
        const errorResponse: WorkerErrorResponse = {
          requestId,
          success: false,
          error: {
            type: "execution_error",
            message: `Failed to serialize result: ${
              jsonError instanceof Error ? jsonError.message : String(jsonError)
            }`,
          },
        };
        postMessage(JSON.stringify(errorResponse));
        return;
      }

      const response: WorkerSuccessResponse = { requestId, success: true, result: cleanResult };

      // Send as JSON string for NodeWorker compatibility
      postMessage(JSON.stringify(response));
    } catch (error) {
      clearTimeout(timeoutId);

      // Check if aborted by timeout
      if (controller.signal.aborted) {
        const response: WorkerErrorResponse = {
          requestId,
          success: false,
          error: { type: "timeout", message: `Code execution timed out after ${timeout}ms` },
        };
        postMessage(JSON.stringify(response));
        return;
      }

      // Syntax error, runtime error, etc.
      const errorStack = error instanceof Error ? error.stack : undefined;

      const response: WorkerErrorResponse = {
        requestId,
        success: false,
        error: { type: "execution_error", message: stringifyError(error), stack: errorStack },
      };
      postMessage(JSON.stringify(response));
    }
  } catch (error) {
    // Unexpected error in message handler itself
    const errorStack = error instanceof Error ? error.stack : undefined;

    const response: WorkerErrorResponse = {
      requestId,
      success: false,
      error: { type: "execution_error", message: stringifyError(error), stack: errorStack },
    };
    postMessage(JSON.stringify(response));
  }
};

/**
 * Execute user-generated code with FSMBuilder API in scope
 *
 * Uses Function constructor to execute code with our APIs injected.
 * User code should set 'result' variable to builder.build() output.
 *
 * @example
 * const builder = new FSMBuilder('my-fsm');
 * builder.setInitialState('start').addState('start').final();
 * const result = builder.build();
 */
function executeUserCode(code: string): Result<FSMDefinition, BuildError[]> {
  // Defensive preprocessing: Strip markdown code fences
  //
  // Despite explicit prompting to output raw executable code, LLMs consistently
  // wrap code in markdown blocks (```typescript ... ```). This behavior is deeply
  // trained across all models and has proven resistant to prompt engineering.
  //
  // We've attempted:
  // - Negative instructions ("DO NOT wrap in markdown")
  // - Positive instructions ("Output only executable TypeScript code")
  // - Example-based prompting
  // - Multiple model variants (Claude Sonnet 4.5, Kimi K2)
  //
  // Result: Markdown wrapping persists with >95% consistency.
  //
  // This preprocessing handles the universal LLM behavior pattern defensively.
  let cleanCode = code.trim();

  // Remove opening fence: ```typescript or ```ts or ```
  if (cleanCode.startsWith("```")) {
    const firstNewline = cleanCode.indexOf("\n");
    if (firstNewline !== -1) {
      cleanCode = cleanCode.substring(firstNewline + 1);
    }
  }

  // Remove closing fence: ```
  if (cleanCode.endsWith("```")) {
    cleanCode = cleanCode.substring(0, cleanCode.length - 3).trim();
  }

  // Create function with our APIs in scope
  // User code can directly use FSMBuilder, agentAction, etc without imports
  //
  // Note: We don't use template literals here to avoid conflicts with backticks
  // in user code. Instead, we concatenate strings.
  const fn = new Function(
    "FSMBuilder",
    "agentAction",
    "codeAction",
    "emitAction",
    "llmAction",
    cleanCode +
      "\n\n" +
      "// Return the result variable that user should have set\n" +
      "if (typeof result === 'undefined') {\n" +
      "  throw new Error(\"Code must set 'result' variable to builder.build() output. Example: const result = builder.build();\");\n" +
      "}\n" +
      "\n" +
      "return result;",
  );

  // Execute with our APIs injected
  return fn(FSMBuilder, agentAction, codeAction, emitAction, llmAction);
}
