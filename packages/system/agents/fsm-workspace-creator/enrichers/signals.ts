/**
 * Signal enricher - converts WorkspacePlan signal prose into workspace.yml signal configs
 * Uses LLM to infer provider type and configuration from natural language descriptions
 */

import { repairJson } from "@atlas/agent-sdk";
import {
  FileWatchSignalConfigSchema,
  HTTPSignalConfigSchema,
  ScheduleSignalConfigSchema,
  type WorkspaceSignalConfig,
} from "@atlas/config";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import { registry } from "@atlas/llm";
import { generateObject } from "ai";
import { z } from "zod";

/**
 * Union of signal config schemas for LLM generation
 * Excludes SystemSignalConfigSchema (system workspaces only)
 */
const SignalConfigSchema = z.discriminatedUnion("provider", [
  ScheduleSignalConfigSchema,
  HTTPSignalConfigSchema,
  FileWatchSignalConfigSchema,
]);

const SignalEnricherOutputSchema = z.object({ result: SignalConfigSchema });

const SYSTEM_PROMPT = `You classify signals and generate workspace.yml configuration.

# Signal Types

**schedule** - Cron-based time triggers
- provider: "schedule"
- config: { schedule: "<cron>", timezone: "<tz>" }
- description: Human-readable explanation
- Use when: "every X", "daily at", "on weekdays", "hourly", time-based phrases
- Examples:
  - "daily at 9am PT" → { provider: "schedule", description: "...", config: { schedule: "0 9 * * *", timezone: "America/Los_Angeles" } }
  - "every 30 minutes" → { provider: "schedule", description: "...", config: { schedule: "*/30 * * * *", timezone: "UTC" } }
  - "weekdays at 8am EST" → { provider: "schedule", description: "...", config: { schedule: "0 8 * * 1-5", timezone: "America/New_York" } }

**http** - Webhook/API endpoints
- provider: "http"
- config: { path: "<endpoint>", timeout?: "<duration>" }
- description: Human-readable explanation
- Use when: "webhook", "API endpoint", "receives events", "HTTP POST", external trigger
- Examples:
  - "GitHub webhook" → { provider: "http", description: "...", config: { path: "/webhook/github", timeout: "30s" } }
  - "manual trigger" → { provider: "http", description: "...", config: { path: "/trigger" } }

**fs-watch** - File system change triggers
- provider: "fs-watch"
- config: { path: "<directory or file>", recursive?: boolean }
- description: Human-readable explanation
- Use when: "watches", "file changes", "new files", "directory monitoring"
- Examples:
  - "watches notes directory" → { provider: "fs-watch", description: "...", config: { path: "./notes", recursive: true } }
  - "monitors file changes" → { provider: "fs-watch", description: "...", config: { path: "./data" } }

# Cron Expression Quick Reference

Format: minute hour day month weekday
- "0 9 * * *" = Daily 9am
- "0 9 * * 1-5" = Weekdays 9am (Monday-Friday)
- "*/30 * * * *" = Every 30 minutes
- "0 */2 * * *" = Every 2 hours
- "0 0 * * 0" = Sundays at midnight
- "0 0 1 * *" = First day of every month at midnight

# Timezone Codes

- America/Los_Angeles (Pacific Time - PT)
- America/Denver (Mountain Time - MT)
- America/Chicago (Central Time - CT)
- America/New_York (Eastern Time - ET)
- UTC (Coordinated Universal Time - default)
- Europe/London (GMT/BST)
- Asia/Tokyo (JST)

# Duration Format

For http timeout fields:
- "30s" = 30 seconds
- "1m" = 1 minute
- "5m" = 5 minutes

# Instructions

1. Read the signal description carefully to identify keywords
2. Determine the correct provider type (schedule, http, or fs-watch)
3. Extract timing/path/endpoint details from the description
4. Generate complete configuration with all required fields
5. For schedule: Default to UTC if timezone not explicitly mentioned
6. For http: Use descriptive path like "/webhook/{service}" or "/trigger/{purpose}"
7. For fs-watch: Use workspace-relative paths (./directory)
8. Copy the original description to the description field (keep it unchanged)

IMPORTANT: The description field should contain the EXACT original description, not a rewritten version.`;

/**
 * Enriches a signal from WorkspacePlan prose into workspace.yml config
 *
 * @param signal - Signal from WorkspacePlan (id, name, title, description)
 * @param abortSignal - Optional abort signal for cancellation
 * @returns Enriched signal with id and complete workspace.yml config
 */
export async function enrichSignal(
  signal: WorkspacePlan["signals"][number],
  abortSignal?: AbortSignal,
): Promise<{ id: string; config: WorkspaceSignalConfig }> {
  const result = await generateObject({
    model: registry.languageModel("anthropic:claude-haiku-4-5"),
    schema: SignalEnricherOutputSchema,
    schemaName: "SignalConfig",
    schemaDescription: "Workspace signal configuration with provider type and settings",
    system: SYSTEM_PROMPT,
    prompt: `Generate signal configuration from this signal:

ID: ${signal.id}
Name: ${signal.name}
Description: ${signal.description}

Return a complete workspace.yml signal config object with provider, description, and config fields.`,
    temperature: 0.2,
    maxRetries: 3,
    abortSignal,
    experimental_repairText: repairJson,
  });

  // Add title from plan and payload schema if present
  const config = {
    ...result.object.result,
    title: signal.title,
    schema: signal.payloadSchema || {},
  };

  return { id: signal.id, config };
}
