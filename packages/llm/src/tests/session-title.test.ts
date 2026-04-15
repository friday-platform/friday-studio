import { expect, it } from "vitest";
import { type GenerateSessionTitleInput, generateSessionTitle } from "../session-title.ts";
import { createStubPlatformModels } from "../test-utils.ts";

const stubPlatformModels = createStubPlatformModels();

function makeInput(overrides: Partial<GenerateSessionTitleInput> = {}): GenerateSessionTitleInput {
  return {
    platformModels: stubPlatformModels,
    signal: { type: "http", id: "test-signal" },
    output: "some output",
    status: "completed",
    ...overrides,
  };
}

function mockLLM(response: string | Error) {
  return () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response));
}

it("generateSessionTitle - returns LLM-generated title on success", async () => {
  const result = await generateSessionTitle(makeInput({ _llm: mockLLM("Processed user request") }));
  expect(result).toEqual("Processed user request");
});

it("generateSessionTitle - truncates titles longer than 60 characters", async () => {
  const longTitle =
    "This is a very long title that exceeds the maximum allowed length of sixty characters";
  const result = await generateSessionTitle(makeInput({ _llm: mockLLM(longTitle) }));

  expect(result.length).toEqual(60);
  expect(result.endsWith("...")).toEqual(true);
});

it("generateSessionTitle - falls back on LLM error", async () => {
  const result = await generateSessionTitle(
    makeInput({
      signal: { type: "daily-report", id: "job-123" },
      _llm: mockLLM(new Error("API error")),
    }),
  );
  expect(result).toEqual("Daily report");
});

it("generateSessionTitle - uses fallback when LLM returns less than 3 characters", async () => {
  const result = await generateSessionTitle(
    makeInput({ signal: { type: "user_sync", id: "sync-1" }, _llm: mockLLM("OK") }),
  );
  expect(result).toEqual("User sync");
});

it("generateSessionTitle - no prefix for failed sessions (status shown via UI badge)", async () => {
  const result = await generateSessionTitle(
    makeInput({ status: "failed", _llm: mockLLM("Database migration") }),
  );
  expect(result).toEqual("Database migration");
});

it("generateSessionTitle - no prefix for skipped sessions (status shown via UI badge)", async () => {
  const result = await generateSessionTitle(
    makeInput({ status: "skipped", _llm: mockLLM("Calendar sync") }),
  );
  expect(result).toEqual("Calendar sync");
});

it("generateSessionTitle - fallback prefers jobName over signal.type", async () => {
  const result = await generateSessionTitle(
    makeInput({
      signal: { type: "http", id: "req-123" },
      jobName: "weekly-cleanup",
      _llm: mockLLM(new Error("API error")),
    }),
  );
  expect(result).toEqual("Weekly cleanup");
});

it("generateSessionTitle - fallback prefers intent from signal.data over jobName", async () => {
  const result = await generateSessionTitle(
    makeInput({
      signal: { type: "http", id: "req-123", data: { intent: "Summarize meeting notes" } },
      jobName: "weekly-cleanup",
      _llm: mockLLM(new Error("API error")),
    }),
  );
  expect(result).toEqual("Summarize meeting notes");
});

it("generateSessionTitle - fallback uses task from signal.data", async () => {
  const result = await generateSessionTitle(
    makeInput({
      signal: { type: "do-task", id: "task-456", data: { task: "Generate quarterly report" } },
      _llm: mockLLM(new Error("API error")),
    }),
  );
  expect(result).toEqual("Generate quarterly report");
});
