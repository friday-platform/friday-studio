/**
 * Signal enrichment eval for FSM workspace creator
 * Tests the ported enricher from workspace-creation to fsm-workspace-creator
 */

import { assert } from "@std/assert";
import { enrichSignal } from "../../../packages/system/agents/fsm-workspace-creator/enrichers/signals.ts";
import { setupTest } from "../../evals/lib/utils.ts";
import { loadCredentials } from "../lib/load-credentials.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

Deno.test("Signal Enrichment - Daily Schedule with Timezone", async (t) => {
  await loadCredentials();

  await step(t, "Daily 9am PT signal enriches to correct cron", async ({ snapshot }) => {
    const signal = {
      id: "daily-standup-reminder",
      name: "Daily Standup Reminder",
      description: "Runs daily at 9am Pacific Time to send standup reminders",
    };

    snapshot({ input: signal });

    const result = await enrichSignal(signal);

    snapshot({ output: result.config });

    assert(result.config.provider === "schedule", "Provider must be schedule");

    if (result.config.provider === "schedule") {
      assert(
        result.config.config.schedule === "0 9 * * *",
        `Expected "0 9 * * *", got "${result.config.config.schedule}"`,
      );
      assert(
        result.config.config.timezone === "America/Los_Angeles" ||
          result.config.config.timezone === "US/Pacific",
        `Expected Pacific timezone, got "${result.config.config.timezone}"`,
      );
    }

    return result;
  });
});

Deno.test("Signal Enrichment - Every 30 Minutes", async (t) => {
  await loadCredentials();

  await step(t, "Interval signal enriches to correct cron", async ({ snapshot }) => {
    const signal = {
      id: "product-check",
      name: "Product Check",
      description: "Runs every 30 minutes to check for new products",
    };

    snapshot({ input: signal });

    const result = await enrichSignal(signal);

    snapshot({ output: result.config });

    assert(result.config.provider === "schedule", "Provider must be schedule");

    if (result.config.provider === "schedule") {
      assert(
        result.config.config.schedule === "*/30 * * * *",
        `Expected "*/30 * * * *", got "${result.config.config.schedule}"`,
      );
    }

    return result;
  });
});

Deno.test("Signal Enrichment - Weekdays Only", async (t) => {
  await loadCredentials();

  await step(t, "Weekday schedule enriches correctly", async ({ snapshot }) => {
    const signal = {
      id: "morning-briefing",
      name: "Morning Briefing",
      description: "Fires every weekday at 8:00 AM EST to generate morning briefing",
    };

    snapshot({ input: signal });

    const result = await enrichSignal(signal);

    snapshot({ output: result.config });

    assert(result.config.provider === "schedule", "Provider must be schedule");

    if (result.config.provider === "schedule") {
      assert(
        result.config.config.schedule === "0 8 * * 1-5",
        `Expected weekday cron "0 8 * * 1-5", got "${result.config.config.schedule}"`,
      );
      assert(
        result.config.config.timezone === "America/New_York" ||
          result.config.config.timezone === "US/Eastern",
        `Expected Eastern timezone, got "${result.config.config.timezone}"`,
      );
    }

    return result;
  });
});

Deno.test("Signal Enrichment - HTTP Webhook", async (t) => {
  await loadCredentials();

  await step(t, "Webhook signal enriches to HTTP provider", async ({ snapshot }) => {
    const signal = {
      id: "github-webhook",
      name: "GitHub Webhook",
      description: "Webhook endpoint receives GitHub push events to trigger CI builds",
    };

    snapshot({ input: signal });

    const result = await enrichSignal(signal);

    snapshot({ output: result.config });

    assert(result.config.provider === "http", "Provider must be http");

    if (result.config.provider === "http") {
      assert(
        result.config.config.path.startsWith("/"),
        `Path must start with /, got "${result.config.config.path}"`,
      );
      assert(
        result.config.config.path.includes("webhook") ||
          result.config.config.path.includes("github"),
        `Path should be descriptive, got "${result.config.config.path}"`,
      );
    }

    return result;
  });
});

Deno.test("Signal Enrichment - File Watch", async (t) => {
  await loadCredentials();

  await step(t, "File watch signal enriches to fs-watch provider", async ({ snapshot }) => {
    const signal = {
      id: "notes-watcher",
      name: "Notes Watcher",
      description: "Watches the notes directory for new markdown files",
    };

    snapshot({ input: signal });

    const result = await enrichSignal(signal);

    snapshot({ output: result.config });

    assert(result.config.provider === "fs-watch", "Provider must be fs-watch");

    if (result.config.provider === "fs-watch") {
      assert(
        result.config.config.path.includes("notes"),
        `Path should reference notes directory, got "${result.config.config.path}"`,
      );
    }

    return result;
  });
});
