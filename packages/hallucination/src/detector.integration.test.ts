/**
 * Hallucination judge integration tests.
 *
 * Hits a real Haiku model via `createPlatformModels`. Gated behind
 * `ANTHROPIC_API_KEY` and skipped in CI — same conventions as
 * `packages/fsm-engine/tests/llm-validation-integration.test.ts`.
 *
 * Verifies the categorized-issue contract: the judge's structured output
 * round-trips into a populated `verdict.issues` array with the correct
 * category enum values, and `retryGuidance` is judge-generated rather than
 * a concatenation of issue strings.
 */

import process from "node:process";
import type { AgentResult } from "@atlas/agent-sdk";
import { createPlatformModels } from "@atlas/llm";
import { describe, expect, it } from "vitest";
import { validate } from "./detector.ts";
import { SupervisionLevel } from "./supervision-levels.ts";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const IS_CI = process.env.CI === "true";
const CAN_RUN_INTEGRATION = !IS_CI && Boolean(ANTHROPIC_API_KEY);

type SuccessResult = AgentResult<string, string> & { ok: true };

function buildResult(overrides: Partial<Omit<SuccessResult, "ok">>): SuccessResult {
  return {
    agentId: overrides.agentId ?? "integration-test",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    input: overrides.input ?? "irrelevant",
    ok: true,
    data: overrides.data ?? "",
    durationMs: overrides.durationMs ?? 0,
    toolCalls: overrides.toolCalls,
    toolResults: overrides.toolResults,
  };
}

describe.skipIf(!CAN_RUN_INTEGRATION)("validate (Real Haiku judge)", () => {
  const platformModels = createPlatformModels(null);
  const config = { platformModels };

  it("well-sourced output does not fail (pass or uncertain)", { timeout: 20_000 }, async () => {
    const result = buildResult({
      input: "Look up the user count and primary contact.",
      data: "There are 42 users in the system. The primary contact is Alice Smith at TechCorp.",
      toolCalls: [
        { type: "tool-call", toolCallId: "tc1", toolName: "getUserCount", input: {} },
        { type: "tool-call", toolCallId: "tc2", toolName: "getContacts", input: { limit: 1 } },
      ],
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "getUserCount",
          input: {},
          output: { count: 42 },
        },
        {
          type: "tool-result",
          toolCallId: "tc2",
          toolName: "getContacts",
          input: { limit: 1 },
          output: { contacts: [{ name: "Alice Smith", company: "TechCorp" }] },
        },
      ],
    });

    const verdict = await validate(result, SupervisionLevel.STANDARD, config);

    expect(verdict.status).not.toBe("fail");
  });

  it("unsourced output with no tools called populates verdict.issues from the schema enum", {
    timeout: 20_000,
  }, async () => {
    const result = buildResult({
      input: "What is the company headcount?",
      data: "According to LinkedIn, the company has 500 employees and was founded in 2014 in Berlin.",
      toolCalls: [],
      toolResults: [],
    });

    const verdict = await validate(result, SupervisionLevel.STANDARD, config);

    expect(verdict.status).not.toBe("pass");
    expect(verdict.issues.length).toBeGreaterThan(0);
    // Categories must come from the enum — the schema cannot emit anything else.
    const validCategories = new Set([
      "sourcing",
      "no-tools-called",
      "judge-uncertain",
      "judge-error",
    ]);
    for (const issue of verdict.issues) {
      expect(validCategories.has(issue.category)).toBe(true);
      expect(issue.severity).toMatch(/^(info|warn|error)$/);
      expect(typeof issue.claim).toBe("string");
      expect(typeof issue.reasoning).toBe("string");
    }
    // retryGuidance is judge-phrased — a string field on the verdict, not
    // a `;`-joined fallback assembled from issue strings.
    expect(typeof verdict.retryGuidance).toBe("string");
    const joined = verdict.issues.map((i) => i.claim).join("; ");
    if (verdict.retryGuidance.length > 0) {
      expect(verdict.retryGuidance).not.toEqual(joined);
    }
  });

  it("passes computed claims that the judge could otherwise miscompute (arithmetic out-of-scope)", {
    timeout: 20_000,
  }, async () => {
    // Deliberate arithmetic that's correct (12 + 30 + 18 = 60). The prompt's
    // out-of-scope section forbids the judge from recomputing this. We assert
    // status != fail rather than == pass — borderline confidence is acceptable.
    const result = buildResult({
      input: "Sum the per-region totals.",
      data: "The total across all three regions is 60 (12 + 30 + 18).",
      toolCalls: [{ type: "tool-call", toolCallId: "tc1", toolName: "getRegions", input: {} }],
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "getRegions",
          input: {},
          output: { regions: [{ total: 12 }, { total: 30 }, { total: 18 }] },
        },
      ],
    });

    const verdict = await validate(result, SupervisionLevel.STANDARD, config);

    expect(verdict.status).not.toBe("fail");
  });
});
