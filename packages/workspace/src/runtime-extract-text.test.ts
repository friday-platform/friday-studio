import { describe, expect, it } from "vitest";
import { extractTextFromAgentOutput } from "./runtime.ts";

describe("extractTextFromAgentOutput", () => {
  it("returns undefined for nullish input", () => {
    expect(extractTextFromAgentOutput(undefined)).toBeUndefined();
    expect(extractTextFromAgentOutput(null)).toBeUndefined();
  });

  it("returns the string verbatim when output is already a string", () => {
    expect(extractTextFromAgentOutput("hello")).toBe("hello");
    expect(extractTextFromAgentOutput("")).toBe("");
  });

  it("walks top-level keys in priority order: text > response > result > output > content > message", () => {
    expect(extractTextFromAgentOutput({ text: "T", response: "R" })).toBe("T");
    expect(extractTextFromAgentOutput({ response: "R", result: "X" })).toBe("R");
    expect(extractTextFromAgentOutput({ result: "X", output: "O" })).toBe("X");
    expect(extractTextFromAgentOutput({ output: "O", content: "C" })).toBe("O");
    expect(extractTextFromAgentOutput({ content: "C", message: "M" })).toBe("C");
    expect(extractTextFromAgentOutput({ message: "M" })).toBe("M");
  });

  it("walks `data.<key>` after top-level keys", () => {
    expect(extractTextFromAgentOutput({ data: { text: "T" } })).toBe("T");
    expect(extractTextFromAgentOutput({ data: { response: "R" } })).toBe("R");
    expect(extractTextFromAgentOutput({ data: { result: "X" } })).toBe("X");
  });

  it("prefers top-level over `data.<key>`", () => {
    expect(extractTextFromAgentOutput({ text: "top", data: { text: "nested" } })).toBe("top");
  });

  it("falls back to JSON.stringify when no recognised key is present", () => {
    expect(extractTextFromAgentOutput({ unknownField: "x", count: 3 })).toBe(
      JSON.stringify({ unknownField: "x", count: 3 }),
    );
  });

  it("ignores non-string values for the recognised keys (no implicit coercion)", () => {
    expect(extractTextFromAgentOutput({ text: 42 })).toBe(JSON.stringify({ text: 42 }));
    expect(extractTextFromAgentOutput({ data: { text: null } })).toBe(
      JSON.stringify({ data: { text: null } }),
    );
  });

  it("coerces primitives that aren't strings or objects via String()", () => {
    expect(extractTextFromAgentOutput(42)).toBe("42");
    expect(extractTextFromAgentOutput(true)).toBe("true");
  });

  it("returns undefined when JSON.stringify throws (circular ref)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(extractTextFromAgentOutput(circular)).toBeUndefined();
  });
});
