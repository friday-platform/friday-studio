import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { extractErrorText, hasErrorPart, hasRenderableContent } from "./message-error.ts";

function msg(parts: AtlasUIMessage["parts"]): AtlasUIMessage {
  return { id: "m1", role: "assistant", parts };
}

describe("message-error helpers", () => {
  describe("hasRenderableContent", () => {
    it("returns false for a phantom data-session-start-only message", () => {
      // Regression for the AI SDK + Svelte $state race where an assistant
      // entry gets created with only session-start. Without filtering, it
      // shows up as an empty "Friday" bubble before text arrives.
      expect(
        hasRenderableContent(
          msg([{ type: "data-session-start", id: "s1", data: { sessionId: "sess_1" } } as never]),
        ),
      ).toBe(false);
    });

    it("returns true when a text part is present", () => {
      expect(hasRenderableContent(msg([{ type: "text", text: "hello" } as never]))).toBe(true);
    });

    it("returns true for tool-<name> parts", () => {
      expect(
        hasRenderableContent(
          msg([{ type: "tool-web_fetch", toolCallId: "c1", state: "input-available" } as never]),
        ),
      ).toBe(true);
    });

    it("returns true for data-error — session-failure turns must be visible", () => {
      // Regression for Ken's bug: data-error parts were filtered out along
      // with phantom session-start-only messages, so session failures left
      // the thinking indicator as the only feedback before it silently
      // vanished at stream close.
      expect(
        hasRenderableContent(
          msg([{ type: "data-error", data: { error: "boom", errorCause: null } } as never]),
        ),
      ).toBe(true);
    });

    it("returns true for data-agent-error and data-agent-timeout", () => {
      expect(
        hasRenderableContent(
          msg([
            {
              type: "data-agent-error",
              data: { agentId: "a1", duration: 100, error: "crashed" },
            } as never,
          ]),
        ),
      ).toBe(true);
      expect(
        hasRenderableContent(
          msg([
            {
              type: "data-agent-timeout",
              data: { agentId: "a1", task: "t", duration: 100, error: "timed out" },
            } as never,
          ]),
        ),
      ).toBe(true);
    });
  });

  describe("extractErrorText", () => {
    it("returns undefined when no error parts are present", () => {
      expect(extractErrorText(msg([{ type: "text", text: "ok" } as never]))).toBeUndefined();
    });

    it("pulls a single data-error message", () => {
      expect(
        extractErrorText(
          msg([
            { type: "data-error", data: { error: "no such column: job_name", errorCause: null } as never },
          ] as never),
        ),
      ).toBe("no such column: job_name");
    });

    it("joins multiple error parts with newlines", () => {
      expect(
        extractErrorText(
          msg([
            { type: "data-error", data: { error: "first", errorCause: null } as never },
            { type: "data-agent-error", data: { agentId: "a", duration: 1, error: "second" } as never },
          ] as never),
        ),
      ).toBe("first\nsecond");
    });

    it("skips parts with missing or empty error strings", () => {
      expect(
        extractErrorText(
          msg([
            { type: "data-error", data: { error: "", errorCause: null } as never },
            { type: "data-error", data: {} as never },
            { type: "data-error", data: { error: "real error", errorCause: null } as never },
          ] as never),
        ),
      ).toBe("real error");
    });
  });

  describe("hasErrorPart", () => {
    it("returns false for a text-only assistant message", () => {
      expect(hasErrorPart(msg([{ type: "text", text: "hi" } as never]))).toBe(false);
    });

    it("returns true when any error part is present", () => {
      expect(
        hasErrorPart(msg([{ type: "data-error", data: { error: "x", errorCause: null } as never }])),
      ).toBe(true);
    });
  });
});
