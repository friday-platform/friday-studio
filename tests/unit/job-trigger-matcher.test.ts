#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env

/**
 * Unit tests for JobTriggerMatcher
 * Tests direct job-signal evaluation using declarative trigger conditions
 */

import { expect } from "@std/expect";
import { type JobSpec, JobTriggerMatcher } from "../../src/core/job-trigger-matcher.ts";

const mockSignal = {
  id: "github-webhook",
  provider: { name: "github" },
  config: {},
} as any;

const mockJobs: Record<string, JobSpec> = {
  "frontend-review": {
    name: "frontend-review",
    description: "Review frontend changes",
    triggers: [
      {
        signal: "github-webhook",
        condition: {
          "and": [
            { "==": [{ "var": "action" }, "opened"] },
            { "in": ["frontend/", { "var": "changed_files" }] },
          ],
        },
        naturalLanguageCondition: "when PR is opened with frontend changes",
      },
    ],
    execution: {
      strategy: "sequential",
      agents: [{ id: "frontend-reviewer" }],
    },
  },
  "backend-review": {
    name: "backend-review",
    description: "Review backend changes",
    triggers: [
      {
        signal: "github-webhook",
        condition: "action == 'opened' && changed_files.includes('backend/')",
        naturalLanguageCondition: "when PR is opened with backend changes",
      },
    ],
    execution: {
      strategy: "parallel",
      agents: [{ id: "backend-reviewer" }],
    },
  },
  "always-trigger": {
    name: "always-trigger",
    description: "Always triggered job",
    triggers: [
      {
        signal: "github-webhook",
        // No condition = always matches
      },
    ],
    execution: {
      strategy: "sequential",
      agents: [{ id: "always-agent" }],
    },
  },
};

Deno.test("JobTriggerMatcher finds matching jobs with JSONLogic conditions", async () => {
  const matcher = new JobTriggerMatcher();

  const payload = {
    action: "opened",
    changed_files: ["frontend/App.tsx", "src/utils.ts"],
  };

  const matches = await matcher.findMatchingJobs(mockSignal, payload, mockJobs);

  // Should match frontend-review and always-trigger
  expect(matches.length).toBeGreaterThanOrEqual(2);

  const frontendMatch = matches.find((m) => m.job.name === "frontend-review");
  expect(frontendMatch).toBeDefined();
  expect(frontendMatch!.evaluationResult.matches).toBe(true);
  expect(frontendMatch!.evaluationResult.confidence).toBeGreaterThan(0.5);

  const alwaysMatch = matches.find((m) => m.job.name === "always-trigger");
  expect(alwaysMatch).toBeDefined();
  expect(alwaysMatch!.evaluationResult.matches).toBe(true);
});

Deno.test("JobTriggerMatcher handles simple expression conditions", async () => {
  const matcher = new JobTriggerMatcher();

  const payload = {
    action: "opened",
    changed_files: ["backend/api.py", "backend/models.py"],
  };

  const matches = await matcher.findMatchingJobs(mockSignal, payload, mockJobs);

  // Should match backend-review and always-trigger
  const backendMatch = matches.find((m) => m.job.name === "backend-review");
  expect(backendMatch).toBeDefined();
  expect(backendMatch!.evaluationResult.matches).toBe(true);
});

Deno.test("JobTriggerMatcher handles no matching conditions", async () => {
  const matcher = new JobTriggerMatcher();

  const payload = {
    action: "closed", // Different action
    changed_files: ["docs/README.md"],
  };

  const matches = await matcher.findMatchingJobs(mockSignal, payload, mockJobs);

  // Should only match always-trigger (no condition = always matches)
  expect(matches.length).toBe(1);
  expect(matches[0].job.name).toBe("always-trigger");
});

Deno.test("JobTriggerMatcher validates job trigger specifications", () => {
  const matcher = new JobTriggerMatcher();

  const invalidJobs: Record<string, JobSpec> = {
    "no-triggers": {
      name: "no-triggers",
      triggers: [],
      execution: { strategy: "sequential", agents: [] },
    },
    "missing-signal": {
      name: "missing-signal",
      triggers: [{ signal: "", condition: "true" }],
      execution: { strategy: "sequential", agents: [] },
    },
    "empty-condition": {
      name: "empty-condition",
      triggers: [{ signal: "test", condition: "" }],
      execution: { strategy: "sequential", agents: [] },
    },
  };

  const validation = matcher.validateJobTriggers(invalidJobs);

  expect(validation.valid).toBe(false);
  expect(validation.errors.length).toBeGreaterThan(0);
  expect(validation.warnings.length).toBeGreaterThan(0);

  // Check specific error for missing signal
  expect(validation.errors.some((e) => e.includes("missing signal field"))).toBe(true);

  // Check specific warning for no triggers
  expect(validation.warnings.some((w) => w.includes("no triggers defined"))).toBe(true);
});

Deno.test("JobTriggerMatcher handles parallel evaluation", async () => {
  const matcher = new JobTriggerMatcher({
    enable_parallel_evaluation: true,
    max_matches_per_signal: 5,
  });

  const payload = {
    action: "opened",
    changed_files: ["frontend/App.tsx", "backend/api.py"],
  };

  const startTime = Date.now();
  const matches = await matcher.findMatchingJobs(mockSignal, payload, mockJobs);
  const duration = Date.now() - startTime;

  // Should find multiple matches quickly with parallel evaluation
  expect(matches.length).toBeGreaterThanOrEqual(2);
  expect(duration).toBeLessThan(1000); // Should be very fast
});

Deno.test("JobTriggerMatcher respects confidence thresholds", async () => {
  const matcher = new JobTriggerMatcher({
    min_confidence: 0.9, // High threshold
  });

  const payload = {
    action: "opened",
    changed_files: ["frontend/App.tsx"],
  };

  const matches = await matcher.findMatchingJobs(mockSignal, payload, mockJobs);

  // All matches should meet the confidence threshold
  for (const match of matches) {
    expect(match.evaluationResult.confidence).toBeGreaterThanOrEqual(0.9);
  }
});

Deno.test("JobTriggerMatcher limits max matches per signal", async () => {
  const matcher = new JobTriggerMatcher({
    max_matches_per_signal: 1,
  });

  const payload = {
    action: "opened",
    changed_files: ["frontend/App.tsx", "backend/api.py"],
  };

  const matches = await matcher.findMatchingJobs(mockSignal, payload, mockJobs);

  // Should limit to 1 match even though multiple jobs would match
  expect(matches.length).toBeLessThanOrEqual(1);

  if (matches.length > 0) {
    // Should return the highest confidence match
    expect(matches[0].evaluationResult.confidence).toBeGreaterThan(0);
  }
});

Deno.test("JobTriggerMatcher handles different signal types", async () => {
  const matcher = new JobTriggerMatcher();

  const differentSignal = {
    id: "slack-message",
    provider: { name: "slack" },
  } as any;

  const jobsWithDifferentSignals: Record<string, JobSpec> = {
    "slack-responder": {
      name: "slack-responder",
      triggers: [{ signal: "slack-message" }],
      execution: { strategy: "sequential", agents: [{ id: "slack-bot" }] },
    },
    "github-only": {
      name: "github-only",
      triggers: [{ signal: "github-webhook" }],
      execution: { strategy: "sequential", agents: [{ id: "github-bot" }] },
    },
  };

  const payload = { message: "Hello from Slack!" };
  const matches = await matcher.findMatchingJobs(
    differentSignal,
    payload,
    jobsWithDifferentSignals,
  );

  // Should only match slack-responder
  expect(matches.length).toBe(1);
  expect(matches[0].job.name).toBe("slack-responder");
});
