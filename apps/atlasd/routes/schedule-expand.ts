/**
 * POST /api/schedule-expand
 *
 * Thin daemon route that accepts { input: string } and calls smallLLM
 * to expand natural language into a structured task brief (ScheduleProposal).
 * Keeps LLM call server-side since the playground has no direct LLM access.
 *
 * @module
 */

import { smallLLM } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const logger = createLogger({ name: "schedule-expand" });

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ScheduleExpandRequestSchema = z.object({ input: z.string().min(1).max(500) });

const ScheduleProposalSchema = z.object({
  task_id: z.string(),
  text: z.string().max(120),
  task_brief: z.string(),
  priority: z.number().int().min(5).max(20),
  kind: z.enum(["feature", "improvement", "bugfix"]),
});

// ─── System prompt ────────────────────────────────────────────────────────────

const EXPANSION_SYSTEM_PROMPT = `You are a task brief generator for the FAST self-improvement loop.
Given a natural-language scheduling request, produce a structured task.

Output valid JSON with exactly these fields:
- task_id: kebab-case identifier (prefix "manual-", max 60 chars)
- text: 1-line human summary (max 120 chars)
- task_brief: full prompt for the coder agent (2-5 sentences)
- priority: integer 5-20 (5=urgent, 20=low)
- kind: one of "feature", "improvement", "bugfix"`;

// ─── Route ────────────────────────────────────────────────────────────────────

export const scheduleExpandRoutes = daemonFactory
  .createApp()
  .post("/", zValidator("json", ScheduleExpandRequestSchema), async (c) => {
    const { input } = c.req.valid("json");
    const ctx = c.get("app");

    logger.info("Expanding schedule input", { inputLength: input.length });

    try {
      const rawResponse = await smallLLM({
        platformModels: ctx.platformModels,
        system: EXPANSION_SYSTEM_PROMPT,
        prompt: input,
        maxOutputTokens: 300,
      });

      // Extract JSON from the response (handle markdown code fences)
      const jsonText = extractJSON(rawResponse);
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        logger.warn("Failed to parse LLM response as JSON", { rawResponse });
        return c.json({ error: "LLM returned invalid JSON" }, 502);
      }

      const result = ScheduleProposalSchema.safeParse(parsed);
      if (!result.success) {
        logger.warn("LLM response failed schema validation", {
          errors: result.error.issues,
          parsed,
        });
        return c.json({ error: "LLM response does not match expected shape" }, 502);
      }

      // Transform snake_case LLM output to camelCase for the client
      const proposal = {
        taskId: result.data.task_id,
        text: result.data.text,
        taskBrief: result.data.task_brief,
        priority: result.data.priority,
        kind: result.data.kind,
      };

      logger.info("Schedule expansion complete", {
        taskId: proposal.taskId,
        priority: proposal.priority,
        kind: proposal.kind,
      });

      return c.json(proposal, 200);
    } catch (error) {
      logger.error("Schedule expansion failed", { error });
      return c.json(
        {
          error: `Schedule expansion failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        500,
      );
    }
  });

/**
 * Extract JSON from a string that may contain markdown code fences.
 * Handles ```json ... ```, ``` ... ```, or raw JSON.
 */
function extractJSON(text: string): string {
  const trimmed = text.trim();
  // Try to extract from code fences
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fenceMatch) {
    const content = fenceMatch[1];
    if (content !== undefined) {
      return content.trim();
    }
  }
  return trimmed;
}
