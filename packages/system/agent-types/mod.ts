import { z } from "zod";

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Structured credential info for error recovery.
 * Enables LLM to pattern-match and call connect_service with the correct provider.
 */
export const MissingCredentialSchema = z.object({
  /** Link provider ID for connect_service (e.g., "google-calendar", "github") */
  provider: z.string(),
  /** Human-readable service name (e.g., "Google Calendar", "GitHub") */
  service: z.string(),
});

/**
 * Success payload for FSMCreatorResult.
 */
export const FSMCreatorSuccessDataSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  workspaceDescription: z.string().optional(),
  workspaceUrl: z.string(),
  jobCount: z.number(),
  metadata: z.object({
    /** jobId -> generated TypeScript code */
    generatedCode: z.record(z.string(), z.string()),
    /** jobId -> number of attempts */
    codegenAttempts: z.record(z.string(), z.number()),
  }),
});

/**
 * Error payload for FSMCreatorResult.
 * Note: For credential errors, missingCredentials JSON is embedded in the reason string
 * so the LLM can still parse it for recovery (e.g., calling connect_service).
 */
export const FSMCreatorErrorDataSchema = z.object({ reason: z.string() });

/**
 * Discriminated union Result type as Zod schema.
 * Mirrors the Result<T, U> pattern from @atlas/utils.
 */
export const FSMCreatorResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: FSMCreatorSuccessDataSchema }),
  z.object({ ok: z.literal(false), error: FSMCreatorErrorDataSchema }),
]);

// ============================================================================
// Inferred TypeScript Types
// ============================================================================

export type MissingCredential = z.infer<typeof MissingCredentialSchema>;
export type FSMCreatorSuccessData = z.infer<typeof FSMCreatorSuccessDataSchema>;
export type FSMCreatorErrorData = z.infer<typeof FSMCreatorErrorDataSchema>;
export type FSMCreatorResult = z.infer<typeof FSMCreatorResultSchema>;
