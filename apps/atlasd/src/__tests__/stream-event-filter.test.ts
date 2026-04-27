import { describe, expect, it } from "vitest";
import { isClientSafeEvent } from "../stream-event-filter.ts";

describe("isClientSafeEvent", () => {
  it("passes data-session-start through (the AI SDK uses it to init the assistant message)", () => {
    expect(isClientSafeEvent({ type: "data-session-start" })).toBe(true);
  });

  it("filters out data-session-finish", () => {
    expect(isClientSafeEvent({ type: "data-session-finish" })).toBe(false);
  });

  it("filters out data-fsm-action-execution", () => {
    expect(isClientSafeEvent({ type: "data-fsm-action-execution" })).toBe(false);
  });

  it("filters out all data-session-* events uniformly", () => {
    expect(isClientSafeEvent({ type: "data-session-anything" })).toBe(false);
  });

  it("passes text-delta chunks through", () => {
    expect(isClientSafeEvent({ type: "text-delta", textDelta: "hello" })).toBe(true);
  });

  it("passes start chunks through", () => {
    expect(isClientSafeEvent({ type: "start", messageId: "msg-1" })).toBe(true);
  });

  it("passes finish chunks through", () => {
    expect(isClientSafeEvent({ type: "finish", finishReason: "stop" })).toBe(true);
  });

  it("passes tool-call chunks through", () => {
    expect(
      isClientSafeEvent({ type: "tool-call", toolCallId: "tc-1", toolName: "x", args: {} }),
    ).toBe(true);
  });

  it("filters out non-object values", () => {
    expect(isClientSafeEvent(null)).toBe(false);
    expect(isClientSafeEvent("string")).toBe(false);
    expect(isClientSafeEvent(42)).toBe(false);
  });

  it("filters out objects without a type field", () => {
    expect(isClientSafeEvent({ foo: "bar" })).toBe(false);
  });
});
