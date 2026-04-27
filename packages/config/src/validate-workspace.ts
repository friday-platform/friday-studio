import { WorkspaceConfigSchema } from "./workspace.ts";

// ==============================================================================
// TYPES
// ==============================================================================

/**
 * A single validation issue with a dot-notation path and plain-English message.
 */
export interface Issue {
  /** Zod issue code (e.g., "invalid_type", "unrecognized_keys") */
  code: string;
  /** Dot-notation path into the config object (e.g., "agents.email-triager.config.model") */
  path: string;
  /** Human-readable error or warning message */
  message: string;
}

/**
 * Result of validating a workspace configuration.
 */
export interface ValidationReport {
  /** Overall validation status */
  status: "ok" | "warning" | "error";
  /** Issues that block publish */
  errors: Issue[];
  /** Issues that do not block publish */
  warnings: Issue[];
}

// ==============================================================================
// VALIDATOR
// ==============================================================================

/**
 * Validate a parsed workspace configuration structurally against the Zod schema.
 *
 * The structural layer walks `ZodError.issues[]` and emits one `Issue` per Zod
 * issue with dot-notation path and plain-English message. It NEVER stringifies
 * a `ZodError`.
 *
 * @param parsedConfig - The parsed workspace configuration object (typically from YAML)
 * @returns ValidationReport with status, errors, and warnings
 */
export function validateWorkspace(parsedConfig: unknown): ValidationReport {
  const parseResult = WorkspaceConfigSchema.safeParse(parsedConfig);

  if (parseResult.success) {
    return { status: "ok", errors: [], warnings: [] };
  }

  const errors: Issue[] = parseResult.error.issues.map((issue) => ({
    code: issue.code,
    path: flattenPath(issue.path as (string | number)[]),
    message: issue.message,
  }));

  return { status: "error", errors, warnings: [] };
}

// ==============================================================================
// HELPERS
// ==============================================================================

/**
 * Flatten a Zod issue path array into dot-notation.
 *
 * Array indices are kept in bracket notation for readability.
 *
 * @example
 * ["signals", "review-inbox", "config", "path"] → "signals.review-inbox.config.path"
 * ["memory", "mounts", 0, "source"] → "memory.mounts.0.source"
 */
function flattenPath(path: (string | number)[]): string {
  return path.join(".");
}
