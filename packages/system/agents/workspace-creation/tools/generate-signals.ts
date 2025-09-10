import { anthropic } from "@ai-sdk/anthropic";
import { HTTPSignalConfigSchema, ScheduleSignalConfigSchema } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { toKebabCase } from "@std/text";
import { generateObject, tool } from "ai";
import { z } from "zod/v4";
import type { WorkspaceBuilder } from "../builder.ts";

const SignalConfigSchema = z.discriminatedUnion("provider", [
  ScheduleSignalConfigSchema.omit({ schema: true }).extend({ id: z.string() }),
  HTTPSignalConfigSchema.omit({ schema: true }).extend({ id: z.string() }),
]);

const systemPrompt = `
  <role>
    You create signals that trigger automations.
  </role>
  <context>
  You create signals to start jobs. The available types are:
    - schedule (time-based)
    - http (webhook/event-based)
  </context>
  <instructions>
    1. Signal creation rules:
      - ONLY create signals explicitly required by the user's needs
      - Choose the SINGLE MOST APPROPRIATE signal type
      - Do NOT add redundant trigger mechanisms
      - HTTP signals are implicit - every signal can be called via HTTP, so only create explicit HTTP signals when that's the ONLY trigger needed

    2. Decision tree:
      - User wants scheduled execution? → schedule ONLY
      - User needs webhook/external trigger? → http ONLY
      - Default to the primary use case mentioned by the user

    3. Identify trigger patterns:
      - Time-based → schedule signal (periodic checks, reports, syncs)
      - Event-based → http signal (webhooks, API calls, external triggers)

    4. For each signal, generate:
      - id: kebab-case identifier describing purpose
      - description: When/why it triggers
      - provider: "schedule" or "http"

      - For schedule signals, include:
        - schedule: "cron expression"  # e.g., "*/30 * * * *" for every 30 min
        - timezone: "UTC"  # or user's timezone if specified
  </instructions>
  `;

export function getGenerateSignalsTool(
  builder: WorkspaceBuilder,
  logger: Logger,
  abortSignal?: AbortSignal,
) {
  return tool({
    description: "Generate all signal configurations for the workspace",
    inputSchema: z.object({ requirements: z.string() }),
    outputSchema: z.object({
      count: z.number(),
      signalIds: z.array(z.string()),
      types: z.array(z.string()),
    }),
    execute: async ({ requirements }) => {
      logger.debug("Generating signals...");
      const res = await generateObject({
        model: anthropic("claude-3-5-haiku-latest"),
        schema: z.object({ signals: z.array(SignalConfigSchema) }),
        system: systemPrompt,
        prompt: `Create an array of signals to meet the following requirements: ${requirements}`,
        temperature: 0.2,
        maxRetries: 3,
        abortSignal,
      });

      const signals = res.object.signals.map(({ id, ...signal }) => ({
        id: toKebabCase(id),
        config: signal,
      }));
      builder.addSignals(signals);

      return {
        count: signals.length,
        signalIds: signals.map((s) => s.id),
        types: [...new Set(res.object.signals.map((s) => s.provider))],
      };
    },
  });
}
