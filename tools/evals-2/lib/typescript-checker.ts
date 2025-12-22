/**
 * TypeScript Compilation Checker
 *
 * Validates that generated FSM code compiles without execution.
 * Wraps code with necessary imports and runs `deno check`.
 */

import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * Valid Context API methods and properties
 * Based on packages/fsm-engine/types.ts Context interface
 */
const VALID_CONTEXT_API = new Set([
  "documents", // Document[] array
  "state", // Current FSM state
  "emit", // Optional emit function
  "updateDoc", // Optional updateDoc function
  "createDoc", // Optional createDoc function
]);

/**
 * Validate Context API usage in generated code
 * Checks that only valid Context methods/properties are used
 */
function validateContextUsage(code: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Find all context.XXXX usages (property access or method calls)
  // Match: context.methodName or context.propertyName
  const contextUsageRegex = /context\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  const matches = code.matchAll(contextUsageRegex);

  const invalidUsages = new Set<string>();

  for (const match of matches) {
    const methodOrProperty = match[1];
    if (!methodOrProperty) continue;

    // Check if this is a valid Context API method/property
    if (!VALID_CONTEXT_API.has(methodOrProperty)) {
      invalidUsages.add(methodOrProperty);
    }
  }

  // Report each invalid usage
  for (const invalid of invalidUsages) {
    errors.push(
      `Invalid Context API: context.${invalid} does not exist.\n` +
        `Valid Context API:\n` +
        `  - context.documents (Document[])\n` +
        `  - context.state (string)\n` +
        `  - context.createDoc?.(doc)\n` +
        `  - context.updateDoc?.(id, data)\n` +
        `  - context.emit?.(signal)\n` +
        `To read documents, use: context.documents.find(d => d.id === 'doc-id')`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if generated FSM code compiles with TypeScript
 *
 * Wraps code with imports (same as codegen.worker.ts scope) and
 * runs `deno check` to validate TypeScript compilation.
 *
 * @param code - Generated FSM code (may include markdown fences)
 * @returns Compilation result with errors if any
 */
export async function checkTypeScriptCompilation(
  code: string,
): Promise<{ success: boolean; errors: string[] }> {
  // Strip markdown fences (LLMs consistently wrap code in ```typescript...```)
  const cleanCode = code
    .replace(/^```(?:typescript|ts|javascript|js)?\n/gm, "")
    .replace(/\n```$/gm, "")
    .trim();

  // Pre-validation: Check Context API usage
  const contextValidation = validateContextUsage(cleanCode);
  if (!contextValidation.valid) {
    return { success: false, errors: contextValidation.errors };
  }

  // Wrap with imports (same scope as codegen.worker.ts)
  const wrapped = `import { FSMBuilder, agentAction, codeAction, emitAction, llmAction } from "@atlas/workspace-builder";

${cleanCode}
`;

  // Create temp file
  const tempFile = join(
    tmpdir(),
    `fsm-check-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
  );

  try {
    await writeFile(tempFile, wrapped, "utf-8");

    // Run deno check (will use project's deno.json for import map resolution)
    const result = await new Promise<{ exitCode: number; stderr: string }>((resolve) => {
      const proc = spawn("deno", ["check", tempFile], {
        cwd: process.cwd(), // Use current working directory to find deno.json
      });
      let stderr = "";

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (exitCode) => {
        resolve({ exitCode: exitCode ?? 1, stderr });
      });

      proc.on("error", (err) => {
        resolve({ exitCode: 1, stderr: `Failed to spawn deno: ${err.message}` });
      });
    });

    if (result.exitCode === 0) {
      return { success: true, errors: [] };
    }

    // Check if only TS6133 errors (unused variables) - these are warnings, not blockers
    const has6133 = result.stderr.includes("TS6133");
    const allErrors = result.stderr.match(/TS\d{4}/g) || [];
    const hasOnlyUnusedWarnings = has6133 && allErrors.every((code) => code === "TS6133");

    if (hasOnlyUnusedWarnings) {
      // Treat unused variable warnings as success (code would still execute)
      return { success: true, errors: [] };
    }

    return { success: false, errors: [result.stderr] };
  } finally {
    // Cleanup temp file
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
