import { z } from "zod/v4";

// ============================================================================
// Parameter Schemas
// ============================================================================

export const signalPathSchema = z.object({
  workspaceId: z.string().meta({ description: "Workspace identifier (ID or name)" }),
  signalId: z.string().meta({ description: "Signal name as defined in workspace configuration" }),
});

// ============================================================================
// Response Schemas
// ============================================================================

export const signalTriggerResponseSchema = z
  .object({
    message: z.string().meta({ description: "Status message" }),
    status: z.literal("processing").meta({ description: "Processing status" }),
    workspaceId: z.string().meta({ description: "Workspace identifier" }),
    signalId: z.string().meta({ description: "Signal identifier" }),
    sessionId: z.string().meta({ description: "Created session ID" }),
  })
  .meta({ description: "Signal trigger response" });

export const errorResponseSchema = z
  .object({ error: z.string().meta({ description: "Error message" }) })
  .meta({ description: "Error response" });

// ============================================================================
// Type Exports
// ============================================================================

type SignalTriggerResponse = z.infer<typeof signalTriggerResponseSchema>;
type ErrorResponse = z.infer<typeof errorResponseSchema>;
