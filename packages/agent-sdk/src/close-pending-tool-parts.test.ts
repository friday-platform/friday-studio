import { describe, expect, it } from "vitest";
import { closePendingToolParts } from "./close-pending-tool-parts.ts";

// Helper: loosely-typed message factory so tests can inspect mutated parts
// without the AI SDK's strict UIMessagePart union getting in the way. The
// sanitizer itself is structurally-typed against `{ type, state, errorText }`.
function msg(parts: Record<string, unknown>[]): { parts: Record<string, unknown>[] } {
  return { parts };
}

function getState(m: { parts: Record<string, unknown>[] }, i: number): string | undefined {
  const v = m.parts[i]?.state;
  return typeof v === "string" ? v : undefined;
}

function getErrorText(m: { parts: Record<string, unknown>[] }, i: number): string | undefined {
  const v = m.parts[i]?.errorText;
  return typeof v === "string" ? v : undefined;
}

describe("closePendingToolParts", () => {
  it("no-ops on a message with no parts", () => {
    const result = closePendingToolParts({});
    expect(result.closed).toBe(0);
  });

  it("no-ops on a message with no tool parts", () => {
    const m = msg([{ type: "step-start" }, { type: "text", text: "hello" }]);
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(0);
    expect(m.parts).toEqual([{ type: "step-start" }, { type: "text", text: "hello" }]);
  });

  it("closes an input-streaming tool part as output-error", () => {
    const m = msg([
      { type: "step-start" },
      { type: "tool-run_code", state: "input-streaming", toolCallId: "t1" },
    ]);
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(1);
    expect(getState(m, 1)).toBe("output-error");
    expect(getErrorText(m, 1)).toBe("Tool call interrupted");
    expect(m.parts[1]?.toolCallId).toBe("t1");
  });

  it("closes an input-available tool part", () => {
    const m = msg([{ type: "tool-web_fetch", state: "input-available", input: { url: "x" } }]);
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(1);
    expect(getState(m, 0)).toBe("output-error");
  });

  it("leaves terminal states alone", () => {
    const m = msg([
      { type: "tool-run_code", state: "output-available", output: "42" },
      { type: "tool-web_fetch", state: "output-error", errorText: "timeout" },
      { type: "tool-write_file", state: "output-denied" },
    ]);
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(0);
    expect(getState(m, 0)).toBe("output-available");
    expect(getState(m, 1)).toBe("output-error");
    expect(getErrorText(m, 1)).toBe("timeout");
    expect(getState(m, 2)).toBe("output-denied");
  });

  it("leaves approval-requested alone (user-driven, not abandoned)", () => {
    const m = msg([{ type: "tool-write_file", state: "approval-requested", toolCallId: "t1" }]);
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(0);
    expect(getState(m, 0)).toBe("approval-requested");
  });

  it("preserves an existing errorText instead of overwriting", () => {
    const m = msg([
      { type: "tool-run_code", state: "input-streaming", errorText: "specific prior reason" },
    ]);
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(1);
    expect(getErrorText(m, 0)).toBe("specific prior reason");
  });

  it("accepts a caller-provided reason", () => {
    const m = msg([{ type: "tool-run_code", state: "input-streaming" }]);
    const result = closePendingToolParts(m, "Session timed out");
    expect(result.closed).toBe(1);
    expect(getErrorText(m, 0)).toBe("Session timed out");
  });

  it("closes dynamic-tool parts (runtime-resolved variant)", () => {
    const m = msg([{ type: "dynamic-tool", state: "input-streaming", toolName: "custom_thing" }]);
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(1);
    expect(getState(m, 0)).toBe("output-error");
  });

  it("handles mixed messages with several tool parts in various states", () => {
    const m = msg([
      { type: "step-start" },
      { type: "tool-run_code", state: "output-available", output: "ok" },
      { type: "tool-web_fetch", state: "input-streaming" },
      { type: "text", text: "partial text" },
      { type: "tool-write_file", state: "input-available" },
    ]);
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(2);
    expect(getState(m, 1)).toBe("output-available");
    expect(getState(m, 2)).toBe("output-error");
    expect(getState(m, 4)).toBe("output-error");
  });

  it("is tolerant of malformed parts (no type / no state)", () => {
    const m = {
      parts: [{ type: "tool-run_code" }, { state: "input-streaming" }, null, "oops"] as unknown[],
    };
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(0);
  });

  it("handles message with non-array parts gracefully", () => {
    const m = { parts: "not an array" as unknown };
    const result = closePendingToolParts(m);
    expect(result.closed).toBe(0);
  });
});
