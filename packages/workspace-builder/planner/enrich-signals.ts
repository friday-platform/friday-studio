/**
 * Phase 1b: Signal Enrichment
 *
 * Converts Phase 1 signal prose descriptions into concrete provider
 * configurations (cron expressions, timezones, webhook paths).
 * Validates schedule signals with verifyCronSchedule.
 */

import { repairJson } from "@atlas/agent-sdk";
import { HTTPProviderConfigSchema, ScheduleProviderConfigSchema } from "@atlas/config";
import { registry, traceModel } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { generateObject } from "ai";
import { CronExpressionParser } from "cron-parser";
import type { z } from "zod";
import type { Signal, SignalConfig } from "../types.ts";

const logger = createLogger({ component: "proto-signal-enrichment" });

type VerifyCronResult = { valid: true; nextFireTimes: string[] } | { valid: false; error: string };

/**
 * Parse a cron expression and return the next 5 fire times.
 * Used during signal enrichment so the LLM can verify cron expressions
 * match the user's intent.
 */
function verifyCronSchedule(expression: string, timezone?: string): VerifyCronResult {
  try {
    const parsed = CronExpressionParser.parse(expression, { tz: timezone ?? "UTC" });
    const dates = parsed.take(5);
    const nextFireTimes = dates.map((d) => d.toISOString() ?? d.toString());
    return { valid: true, nextFireTimes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message };
  }
}

const SCHEDULE_SYSTEM_PROMPT = `You extract cron schedule configuration from signal descriptions.

# Cron Quick Reference (minute hour day month weekday)
- "0 9 * * *" = Daily 9am
- "0 9 * * 1-5" = Weekdays 9am (Monday-Friday)
- "*/30 * * * *" = Every 30 minutes
- "0 */2 * * *" = Every 2 hours
- "0 0 * * 0" = Sundays at midnight
- "0 0 1 * *" = First of every month at midnight

# Timezone Codes
- America/Los_Angeles (Pacific Time, PT, PST)
- America/Denver (Mountain Time, MT, MST)
- America/Chicago (Central Time, CT, CST)
- America/New_York (Eastern Time, ET, EST)
- UTC (default)
- Europe/London (GMT/BST)

# Instructions
1. Extract the cron expression from the description
2. Extract the timezone — default to UTC if not mentioned
3. Return schedule (cron string) and timezone (IANA string)`;

const HTTP_SYSTEM_PROMPT = `You extract webhook/API endpoint configuration from signal descriptions.

# Instructions
1. Generate a descriptive path like "/webhook/github" or "/trigger/analyze"
2. Include timeout if the description mentions processing duration
3. Default timeout is omitted (system default applies)`;

const ENRICHMENT_CONFIG = {
  schedule: {
    schema: ScheduleProviderConfigSchema,
    schemaName: "ScheduleConfig",
    schemaDescription: "Cron schedule with timezone",
    systemPrompt: SCHEDULE_SYSTEM_PROMPT,
  },
  http: {
    schema: HTTPProviderConfigSchema,
    schemaName: "HTTPConfig",
    schemaDescription: "HTTP webhook endpoint configuration",
    systemPrompt: HTTP_SYSTEM_PROMPT,
  },
};

/**
 * Call LLM to extract signal configuration from a description.
 * All signal types use the same generateObject call — only schema, prompts differ.
 */
async function callEnrichmentLLM<S extends z.ZodType>(
  signal: Signal,
  opts: { schema: S; schemaName: string; schemaDescription: string; systemPrompt: string },
  abortSignal?: AbortSignal,
) {
  const { object } = await generateObject({
    model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
    schema: opts.schema,
    experimental_repairText: repairJson,
    schemaName: opts.schemaName,
    schemaDescription: opts.schemaDescription,
    system: opts.systemPrompt,
    prompt: `Extract ${opts.schemaDescription.toLowerCase()} from this signal:

Name: ${signal.name}
Description: ${signal.description}
${signal.displayLabel ? `Display label: ${signal.displayLabel}` : ""}`,
    temperature: 0.2,
    maxRetries: 3,
    abortSignal,
  });

  return object;
}

/**
 * Enrich signals with concrete provider configuration.
 * Schedule signals get cron expressions + timezones, validated via verifyCronSchedule.
 * HTTP signals get webhook paths.
 */
export async function enrichSignals(
  signals: Signal[],
  options?: { abortSignal?: AbortSignal },
): Promise<Signal[]> {
  const enriched: Signal[] = [];

  for (const signal of signals) {
    if (signal.signalConfig) {
      enriched.push(signal);
      continue;
    }

    logger.info("Enriching signal", { signalId: signal.id, signalType: signal.signalType });

    // Switch preserves discriminated union narrowing for SignalConfig
    let signalConfig: SignalConfig;
    switch (signal.signalType) {
      case "schedule":
        signalConfig = {
          provider: "schedule",
          config: await callEnrichmentLLM(signal, ENRICHMENT_CONFIG.schedule, options?.abortSignal),
        };
        break;
      case "http":
        signalConfig = {
          provider: "http",
          config: await callEnrichmentLLM(signal, ENRICHMENT_CONFIG.http, options?.abortSignal),
        };
        break;
    }

    if (signalConfig.provider === "schedule") {
      const verification = verifyCronSchedule(
        signalConfig.config.schedule,
        signalConfig.config.timezone,
      );
      if (verification.valid) {
        logger.info("Cron schedule verified", {
          signalId: signal.id,
          schedule: signalConfig.config.schedule,
          timezone: signalConfig.config.timezone,
          nextFire: verification.nextFireTimes[0],
        });
      } else {
        logger.warn("Cron schedule validation failed — config still attached", {
          signalId: signal.id,
          schedule: signalConfig.config.schedule,
          error: verification.error,
        });
      }
    }

    enriched.push({ ...signal, signalConfig });
  }

  return enriched;
}
