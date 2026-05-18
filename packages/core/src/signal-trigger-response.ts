/**
 * Response shape returned in a 2xx body by atlasd's signal-trigger endpoint
 * (`POST /api/workspaces/:ws/signals/:sig`). Atlasd emits exactly two shapes:
 *
 *   - `completed` — synchronous mode, cascade ran to completion
 *   - `accepted`  — `?nowait=true` or webhook mode, cascade dispatched async
 *
 * Terminal failures (workspace error, cascade reject, etc.) come back as
 * non-2xx and surface at consumers via `result.ok === false` from
 * `parseResult`, not as a `status: "failed"` body. Keep this union tight
 * to what atlasd actually emits — a wider union would only protect a
 * hypothetical contract.
 *
 * Single source of truth for both the producer (atlasd's route handler at
 * `apps/atlasd/routes/workspaces/index.ts`) and the consumers (mcp-server,
 * atlas-cli, workspace-chat job-tools, agent-playground run-job-dialog).
 * A schema rename here trips downstream consumers' Zod parse instantly
 * instead of letting drift sneak through TypeScript-only narrowing.
 */
import { z } from "zod";

export const SignalTriggerResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    sessionId: z.string(),
    output: z.unknown().optional(),
    summary: z.string().optional(),
  }),
  z.object({ status: z.literal("accepted"), correlationId: z.string() }),
]);

export type SignalTriggerResponse = z.infer<typeof SignalTriggerResponseSchema>;
