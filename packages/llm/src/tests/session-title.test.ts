import { assertEquals } from "@std/assert";
import { type GenerateSessionTitleInput, generateSessionTitle } from "../session-title.ts";

function makeInput(overrides: Partial<GenerateSessionTitleInput> = {}): GenerateSessionTitleInput {
  return {
    signal: { type: "http", id: "test-signal" },
    output: "some output",
    status: "completed",
    ...overrides,
  };
}

function mockLLM(response: string | Error) {
  return () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response));
}

Deno.test("generateSessionTitle - returns LLM-generated title on success", async () => {
  const result = await generateSessionTitle(makeInput({ _llm: mockLLM("Processed user request") }));
  assertEquals(result, "Processed user request");
});

Deno.test("generateSessionTitle - truncates titles longer than 60 characters", async () => {
  const longTitle =
    "This is a very long title that exceeds the maximum allowed length of sixty characters";
  const result = await generateSessionTitle(makeInput({ _llm: mockLLM(longTitle) }));

  assertEquals(result.length, 60);
  assertEquals(result.endsWith("..."), true);
});

Deno.test("generateSessionTitle - falls back on LLM error", async () => {
  const result = await generateSessionTitle(
    makeInput({
      signal: { type: "daily-report", id: "job-123" },
      _llm: mockLLM(new Error("API error")),
    }),
  );
  assertEquals(result, "Daily report");
});

Deno.test("generateSessionTitle - uses fallback when LLM returns less than 3 characters", async () => {
  const result = await generateSessionTitle(
    makeInput({ signal: { type: "user_sync", id: "sync-1" }, _llm: mockLLM("OK") }),
  );
  assertEquals(result, "User sync");
});

Deno.test("generateSessionTitle - no prefix for failed sessions (status shown via UI badge)", async () => {
  const result = await generateSessionTitle(
    makeInput({ status: "failed", _llm: mockLLM("Database migration") }),
  );
  assertEquals(result, "Database migration");
});

Deno.test("generateSessionTitle - no prefix for skipped sessions (status shown via UI badge)", async () => {
  const result = await generateSessionTitle(
    makeInput({ status: "skipped", _llm: mockLLM("Calendar sync") }),
  );
  assertEquals(result, "Calendar sync");
});

Deno.test("generateSessionTitle - fallback prefers jobName over signal.type", async () => {
  const result = await generateSessionTitle(
    makeInput({
      signal: { type: "http", id: "req-123" },
      jobName: "weekly-cleanup",
      _llm: mockLLM(new Error("API error")),
    }),
  );
  assertEquals(result, "Weekly cleanup");
});

Deno.test("generateSessionTitle - fallback prefers intent from signal.data over jobName", async () => {
  const result = await generateSessionTitle(
    makeInput({
      signal: { type: "http", id: "req-123", data: { intent: "Summarize meeting notes" } },
      jobName: "weekly-cleanup",
      _llm: mockLLM(new Error("API error")),
    }),
  );
  assertEquals(result, "Summarize meeting notes");
});

Deno.test("generateSessionTitle - fallback uses task from signal.data", async () => {
  const result = await generateSessionTitle(
    makeInput({
      signal: { type: "do-task", id: "task-456", data: { task: "Generate quarterly report" } },
      _llm: mockLLM(new Error("API error")),
    }),
  );
  assertEquals(result, "Generate quarterly report");
});
