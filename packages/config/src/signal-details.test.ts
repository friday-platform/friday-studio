/**
 * Tests for deriveSignalDetails — extracts signal metadata and
 * maps signals to the jobs they trigger.
 */

import { describe, expect, test } from "vitest";
import { createTestConfig } from "./mutations/test-fixtures.ts";
import { deriveSignalDetails } from "./signal-details.ts";

describe("deriveSignalDetails", () => {
  test("extracts HTTP signal with schema and triggered job", () => {
    const config = createTestConfig({
      signals: {
        "review-pr": {
          provider: "http",
          description: "Trigger a PR review",
          title: "Review a Pull Request",
          config: { path: "/webhooks/review-pr" },
          schema: {
            type: "object",
            properties: { pr_url: { type: "string" } },
            required: ["pr_url"],
          },
        },
      },
      jobs: {
        "pr-code-review": {
          triggers: [{ signal: "review-pr" }],
          fsm: {
            id: "pr",
            initial: "idle",
            states: { idle: { on: { "review-pr": { target: "done" } } }, done: { type: "final" } },
          },
        },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({
      name: "review-pr",
      provider: "http",
      title: "Review a Pull Request",
      endpoint: "/webhooks/review-pr",
      schedule: undefined,
      schema: { type: "object", properties: { pr_url: { type: "string" } }, required: ["pr_url"] },
      triggeredJobs: ["pr-code-review"],
    });
  });

  test("extracts schedule signal with cron expression", () => {
    const config = createTestConfig({
      signals: {
        "daily-report": {
          provider: "schedule",
          description: "Daily report trigger",
          config: { schedule: "0 9 * * *" },
        },
      },
      jobs: {
        "nightly-report": {
          triggers: [{ signal: "daily-report" }],
          fsm: {
            id: "report",
            initial: "idle",
            states: {
              idle: { on: { "daily-report": { target: "done" } } },
              done: { type: "final" },
            },
          },
        },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details).toHaveLength(1);
    expect(details[0]?.provider).toBe("schedule");
    expect(details[0]?.schedule).toBe("0 9 * * *");
    expect(details[0]?.endpoint).toBeUndefined();
    expect(details[0]?.triggeredJobs).toEqual(["nightly-report"]);
  });

  test("signal triggering multiple jobs", () => {
    const config = createTestConfig({
      signals: {
        webhook: { provider: "http", description: "Shared webhook", config: { path: "/hook" } },
      },
      jobs: {
        "job-a": {
          triggers: [{ signal: "webhook" }],
          fsm: {
            id: "a",
            initial: "idle",
            states: { idle: { on: { webhook: { target: "done" } } }, done: { type: "final" } },
          },
        },
        "job-b": {
          triggers: [{ signal: "webhook" }],
          fsm: {
            id: "b",
            initial: "idle",
            states: { idle: { on: { webhook: { target: "done" } } }, done: { type: "final" } },
          },
        },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details).toHaveLength(1);
    expect(details[0]?.triggeredJobs).toEqual(["job-a", "job-b"]);
  });

  test("returns empty array when no signals defined", () => {
    const config = createTestConfig({});

    const details = deriveSignalDetails(config);

    expect(details).toEqual([]);
  });

  test("signal with no schema returns null schema", () => {
    const config = createTestConfig({
      signals: {
        simple: { provider: "http", description: "No schema signal", config: { path: "/simple" } },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details).toHaveLength(1);
    expect(details[0]?.schema).toBeNull();
  });

  test("signal not referenced by any job has empty triggeredJobs", () => {
    const config = createTestConfig({
      signals: {
        orphan: { provider: "http", description: "Unused signal", config: { path: "/orphan" } },
      },
      jobs: {
        "some-job": {
          triggers: [{ signal: "other-signal" }],
          fsm: {
            id: "j",
            initial: "idle",
            states: {
              idle: { on: { "other-signal": { target: "done" } } },
              done: { type: "final" },
            },
          },
        },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details).toHaveLength(1);
    expect(details[0]?.triggeredJobs).toEqual([]);
  });

  test("includes title when defined", () => {
    const config = createTestConfig({
      signals: {
        "my-signal": {
          provider: "http",
          description: "A signal",
          title: "My Custom Title",
          config: { path: "/path" },
        },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details[0]?.title).toBe("My Custom Title");
  });

  test("title is undefined when not set", () => {
    const config = createTestConfig({
      signals: {
        "no-title": {
          provider: "http",
          description: "No title signal",
          config: { path: "/no-title" },
        },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details[0]?.title).toBeUndefined();
  });

  test("extracts timezone for schedule signals", () => {
    const config = createTestConfig({
      signals: {
        "daily-digest": {
          provider: "schedule",
          description: "Daily digest",
          config: { schedule: "0 9 * * *", timezone: "America/New_York" },
        },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details[0]?.timezone).toBe("America/New_York");
    expect(details[0]?.schedule).toBe("0 9 * * *");
  });

  test("schedule signal timezone defaults to UTC", () => {
    const config = createTestConfig({
      signals: {
        cron: {
          provider: "schedule",
          description: "Cron trigger",
          config: { schedule: "*/5 * * * *" },
        },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details[0]?.timezone).toBe("UTC");
  });

  test("extracts watchPath for fs-watch signals", () => {
    const config = createTestConfig({
      signals: {
        "file-change": {
          provider: "fs-watch",
          description: "Watch for file changes",
          config: { path: "/data/incoming" },
        },
      },
    });

    const details = deriveSignalDetails(config);

    expect(details[0]?.provider).toBe("fs-watch");
    expect(details[0]?.watchPath).toBe("/data/incoming");
    expect(details[0]?.endpoint).toBeUndefined();
    expect(details[0]?.schedule).toBeUndefined();
  });
});
