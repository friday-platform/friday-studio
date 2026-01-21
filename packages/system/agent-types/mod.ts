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
  workspaceDescription: z.string(),
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
 */
export const FSMCreatorErrorDataSchema = z.object({
  reason: z.string(),
  /** Structured credential info for LLM to call connect_service */
  missingCredentials: z.array(MissingCredentialSchema).optional(),
  /** Suggested recovery action for the LLM */
  suggestedAction: z.literal("connect_service").optional(),
});

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
