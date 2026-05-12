import { describe, expect, it } from "vitest";
import { needsUserAction } from "./tool-call-utils.ts";
import type { ToolCallDisplay } from "./types.ts";

function call(overrides: Partial<ToolCallDisplay> = {}): ToolCallDisplay {
  return {
    toolCallId: "call-1",
    toolName: "plan-trip",
    state: "input-available",
    ...overrides,
  };
}

describe("tool call user-action detection", () => {
  it("surfaces a parent job card when a nested request_human_input is pending", () => {
    expect(
      needsUserAction(
        call({
          children: [
            call({
              toolCallId: "hitl-1",
              toolName: "request_human_input",
              state: "input-available",
              input: { question: "Which trip style sounds best to you?" },
            }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("does not keep a parent job card action-lifted after nested HITL completes", () => {
    expect(
      needsUserAction(
        call({
          children: [
            call({
              toolCallId: "hitl-1",
              toolName: "request_human_input",
              state: "output-available",
              output: { status: "answered" },
            }),
          ],
        }),
      ),
    ).toBe(false);
  });
});
