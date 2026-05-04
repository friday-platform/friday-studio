/**
 * Mutation types for workspace configuration partial updates
 *
 * These types support pure functional transformations of WorkspaceConfig,
 * with discriminated unions for errors and cascade targets.
 */

import type { z } from "zod";
import type { WorkspaceConfig } from "../workspace.ts";

// ==============================================================================
// MUTATION FUNCTION TYPE
// ==============================================================================

/**
 * A mutation function takes current config, entity ID, and update payload,
 * returning either the updated config or an error.
 *
 * @template T - The type of the update payload
 */
export type MutationFn<T> = (
  config: WorkspaceConfig,
  entityId: string,
  update: T,
) => MutationResult<WorkspaceConfig>;

// ==============================================================================
// MUTATION RESULT
// ==============================================================================

/**
 * Result of a mutation operation - either success with new config,
 * or failure with typed error.
 *
 * @template T - The success value type (typically WorkspaceConfig)
 */
export type MutationResult<T> = { ok: true; value: T } | { ok: false; error: MutationError };

// ==============================================================================
// MUTATION ERRORS
// ==============================================================================

/**
 * Error when the requested entity doesn't exist in the config.
 */
export interface NotFoundError {
  type: "not_found";
  entityId: string;
  entityType: string;
}

/**
 * Error when the update payload fails Zod validation.
 */
export interface ValidationError {
  type: "validation";
  message: string;
  issues: z.ZodIssue[];
}

/**
 * Error when deletion would orphan dependent entities.
 * Includes `willUnlinkFrom` to inform the caller what would be affected.
 * Caller can retry with `force: true` to proceed.
 */
export interface ConflictError {
  type: "conflict";
  willUnlinkFrom: CascadeTarget[];
}

/**
 * Error for operations that are not allowed (e.g., changing signal provider type).
 */
export interface InvalidOperationError {
  type: "invalid_operation";
  message: string;
}

/**
 * Error when writing config to disk fails (permissions, disk full, etc.).
 */
export interface WriteError {
  type: "write";
  message: string;
}

/**
 * Error when a mutation is not representable in the target format.
 *
 * Used by blueprint mutations to signal that the requested change cannot be
 * expressed in the blueprint schema (e.g., non-prompt agent fields, system
 * signal providers). Callers should surface this as a 422 — not silently
 * fall back to a different code path.
 */
export interface NotSupportedError {
  type: "not_supported";
  message: string;
}

/**
 * Discriminated union of all mutation error types.
 */
export type MutationError =
  | NotFoundError
  | ValidationError
  | ConflictError
  | InvalidOperationError
  | WriteError
  | NotSupportedError;

// ==============================================================================
// ERROR CONSTRUCTION HELPERS
// ==============================================================================

/**
 * Creates a NotFoundError for when an entity doesn't exist.
 *
 * @param entityId - ID of the entity that wasn't found
 * @param entityType - Type of entity (e.g., "agent", "signal", "tool")
 */
export function notFoundError(entityId: string, entityType: string): NotFoundError {
  return { type: "not_found", entityId, entityType };
}

/**
 * Creates a ValidationError for when input fails validation.
 *
 * @param message - Human-readable error message
 * @param issues - Zod issues if from schema validation, empty array otherwise
 */
export function validationError(message: string, issues: z.ZodIssue[] = []): ValidationError {
  return { type: "validation", message, issues };
}

/**
 * Creates a ConflictError for when an operation would affect dependent entities.
 *
 * @param willUnlinkFrom - Entities that would be affected (empty array for create conflicts)
 */
export function conflictError(willUnlinkFrom: CascadeTarget[] = []): ConflictError {
  return { type: "conflict", willUnlinkFrom };
}

/**
 * Creates an InvalidOperationError for type change attempts.
 *
 * @param oldType - Current type value
 * @param newType - Attempted new type value
 * @param fieldName - Name of the field (e.g., "agent type", "signal provider type")
 */
export function typeChangeError(
  oldType: string,
  newType: string,
  fieldName: string,
): InvalidOperationError {
  return {
    type: "invalid_operation",
    message: `Cannot change ${fieldName} from '${oldType}' to '${newType}'`,
  };
}

// ==============================================================================
// CASCADE TARGETS
// ==============================================================================

/**
 * A top-level LLM agent that references the entity being modified/deleted.
 */
export interface AgentCascadeTarget {
  type: "agent";
  agentId: string;
}

/**
 * A job that references the entity being modified/deleted.
 * `remainingTriggers` indicates how many triggers would remain after unlinking.
 */
export interface JobCascadeTarget {
  type: "job";
  jobId: string;
  remainingTriggers: number;
}

/**
 * Discriminated union of entities that would be affected by a cascade.
 */
export type CascadeTarget = AgentCascadeTarget | JobCascadeTarget;

// ==============================================================================
// DELETE OPTIONS
// ==============================================================================

/**
 * Options for delete operations.
 * Use `force: true` to cascade delete dependent references.
 */
export interface DeleteOptions {
  force?: boolean;
}

// ==============================================================================
// CONFIG WRITER INTERFACE
// ==============================================================================

/**
 * Interface for persisting workspace configuration to disk.
 * Injected for testing - allows mocking filesystem operations.
 */
export interface ConfigWriter {
  /**
   * Write config to the specified file path.
   * @param configPath - Full path to the config file (workspace.yml or eph_workspace.yml)
   * @param config - The workspace configuration to write
   */
  write(configPath: string, config: WorkspaceConfig): Promise<void>;
}
