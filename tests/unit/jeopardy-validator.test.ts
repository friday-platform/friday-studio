import { createLogger } from "@atlas/logger";
import { assert, assertEquals, assertFalse } from "@std/assert";
import { MockLanguageModelV2 } from "ai/test";
import {
  type JeopardyValidationRequest,
  type JeopardyValidationResult,
  JeopardyValidator,
} from "../../src/core/services/jeopardy-validator.ts";

// Silence logger output and file writes during tests
Deno.env.set("DENO_TESTING", "true");
const logger = createLogger({ component: "JeopardyValidatorUnitTest", test: true });

function createValidator(
  overrides: Partial<ConstructorParameters<typeof JeopardyValidator>[0]> = {},
) {
  return new JeopardyValidator({
    enabled: true,
    model: "mock-model",
    llmProvider: () =>
      new MockLanguageModelV2({
        // Default: a minimal valid JSON body
        doGenerate: async () => ({
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [
            {
              type: "text",
              text: `{"answersTask":true,"completeness":1,"confidence":1,"issues":[],"reasoning":""}`,
            },
          ],
          warnings: [],
        }),
      }) as unknown as import("ai").LanguageModel,
    logger,
    ...overrides,
  });
}

Deno.test("jeopardy: returns disabled result when disabled", async () => {
  const v = createValidator({ enabled: false });
  const res = await v.validate({ originalTask: "Do X", agentOutput: "some output", agentId: "a1" });
  assert(res.isValid);
  assert(res.answersTask);
  assertEquals(res.confidence, 0.5);
  assert(res.issues.some((i) => i.description.includes("disabled")));
});

Deno.test("jeopardy: combines structured issues with task-derived source checks; blocks on critical wrong_source", async () => {
  const v = createValidator({
    llmProvider: () =>
      new MockLanguageModelV2({
        doGenerate: async () => ({
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [
            {
              type: "text",
              text: `{"answersTask":true,"completeness":0.4,"confidence":0.6,"issues":[{"type":"incomplete","description":"missing key fields","severity":"medium"}],"reasoning":"partial"}`,
            },
          ],
          warnings: [],
        }),
      }) as unknown as import("ai").LanguageModel,
  });
  const req: JeopardyValidationRequest = {
    originalTask: "List 3 airbnb.com listings with links (from airbnb.com only)",
    // External data with disallowed domain
    agentOutput: "Here are options: Hotel A - https://hotels.com/a, Hotel B - https://hotels.com/b",
    agentId: "agent-x",
  };

  const res: JeopardyValidationResult = await v.validate(req);

  // Expect critical wrong_source + medium format_mismatch + structured incomplete
  const types = res.issues.map((i) => i.type);
  assert(types.includes("incomplete"));
  assert(types.includes("wrong_source"));

  // Since critical exists, isValid must be false even if answersTask was true
  assertFalse(res.isValid);
});

Deno.test("jeopardy: respects task-derived allowedSources; isValid true when no critical issues", async () => {
  const v = createValidator({
    llmProvider: () =>
      new MockLanguageModelV2({
        doGenerate: async () => ({
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [
            {
              type: "text",
              text: `{"answersTask":true,"completeness":0.9,"confidence":0.9,"issues":[],"reasoning":"good"}`,
            },
          ],
          warnings: [],
        }),
      }) as unknown as import("ai").LanguageModel,
  });
  const req: JeopardyValidationRequest = {
    originalTask: "Provide hotel links from hotels.com",
    agentOutput: "See https://www.hotels.com/x for details.",
    agentId: "agent-y",
  };

  const res = await v.validate(req);
  // Domain allowed -> no wrong_source; valid overall
  assert(res.isValid);
  assertEquals(
    res.issues.find((i) => i.type === "wrong_source"),
    undefined,
  );
});

Deno.test("jeopardy: returns error result when LLM call fails", async () => {
  const v = createValidator({
    llmProvider: () =>
      new MockLanguageModelV2({
        doGenerate: async () => {
          throw new Error("boom");
        },
      }) as unknown as import("ai").LanguageModel,
  });
  const res = await v.validate({ originalTask: "X", agentOutput: "Y", agentId: "z" });
  assert(res.isValid);
  assert(res.issues.some((i) => i.description.includes("Validator unavailable")));
});
