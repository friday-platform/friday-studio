import {
  FileWatchSignalConfigSchema,
  HTTPSignalConfigSchema,
  ScheduleSignalConfigSchema,
  type WorkspaceSignalConfig,
} from "@atlas/config";
import { ANTHROPIC_CACHE_BREAKPOINT, anthropic } from "@atlas/core";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import { logger } from "@atlas/logger";
import { generateObject } from "ai";
import { z } from "zod";

const SignalConfigSchema = z.union([
  ScheduleSignalConfigSchema.omit({ schema: true }),
  HTTPSignalConfigSchema.omit({ schema: true }),
  FileWatchSignalConfigSchema.omit({ schema: true }),
]);

const SignalEnricherSchema = z.object({ result: SignalConfigSchema });

const systemPrompt = `<role>
You classify signal types and generate configuration parameters.
</role>

<context>
You receive a signal with an ID, name, and description. Your task is to:
1. Determine the signal type (schedule, http, or fs-watch)
2. Extract configuration parameters from the description
3. Return a complete signal configuration
</context>

<signal_types>
- schedule: Time-based triggers (cron expressions)
  - Requires: schedule (cron), timezone
  - Example: "*/30 * * * *" for every 30 minutes

- http: Webhook/event-based triggers
  - Requires: method, path (optional)
  - Example: POST /webhook/github-push

- fs-watch: File system change triggers
  - Requires: path (directory or file to watch)
  - Example: /workspace/notes or ./uploads
</signal_types>

<instructions>
1. Analyze the signal description to determine the most appropriate type
2. Extract configuration parameters from the description
3. Use sensible defaults if specific values aren't mentioned
4. For schedule signals, default to UTC timezone unless specified
5. For HTTP signals, default to POST method unless specified
6. For fs-watch signals, use the path mentioned in the description
</instructions>

<examples>
Signal: "Runs every hour to check for new products"
→ { provider: "schedule", schedule: "0 * * * *", timezone: "UTC" }

Signal: "Webhook receives GitHub push events"
→ { provider: "http", method: "POST", path: "/webhook/github" }

Signal: "Watches the notes directory for new files"
→ { provider: "fs-watch", config: { path: "./notes" } }
</examples>`;

export async function enrichSignal(
  signal: WorkspacePlan["signals"][number],
  abortSignal?: AbortSignal,
): Promise<{ id: string; config: WorkspaceSignalConfig }> {
  const result = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: SignalEnricherSchema,
    messages: [
      { role: "system", content: systemPrompt, providerOptions: ANTHROPIC_CACHE_BREAKPOINT },
      {
        role: "user",
        content: `Classify this signal and generate its configuration:

ID: ${signal.id}
Name: ${signal.name}
Description: ${signal.description}

Return a signal configuration object with provider, description, and config fields.`,
      },
    ],
    temperature: 0.2,
    maxRetries: 3,
    abortSignal,
  });

  logger.debug("AI SDK generateObject completed", {
    agent: "signal-enricher",
    step: "enrich-signal-configuration",
    usage: result.usage,
  });

  return { id: signal.id, config: result.object.result };
}
