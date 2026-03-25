/**
 * In-process code executor for environments without Deno Workers.
 *
 * Evaluates FSM code functions (guards, actions, tools) inline using
 * `new Function()`. Same evaluation technique as the Worker-based executor
 * but without the serialization/deserialization boundary.
 *
 * @module
 */

import type { CodeExecutor } from "@atlas/fsm-engine";

/**
 * Creates a CodeExecutor that runs compiled FSM functions in-process.
 *
 * Used by the playground (Vite/Node) where Deno Web Workers aren't available.
 * No sandboxing — fine for a local dev tool.
 */
export function createInlineCodeExecutor(): CodeExecutor {
  return {
    async execute(functionCode, _functionName, context, signal) {
      // Same transform as function-executor.worker.ts:126-131
      let cleanCode = functionCode.trim();
      if (cleanCode.startsWith("export default")) {
        cleanCode = cleanCode.replace("export default", "const __fn__ =");
      } else {
        cleanCode = `const __fn__ = ${cleanCode}`;
      }

      const fn = new Function(
        "context",
        "event",
        `${cleanCode}; return __fn__(context, event);`,
      );

      return await Promise.resolve(fn(context, signal));
    },
  };
}
