import { describe, expect, it } from "vitest";
import type { Elicitation } from "@atlas/core/elicitations/model";
import type { ToolCallDisplay } from "./types.ts";
import {
  findMatchingHumanInputElicitation,
  readElicitationIdFromToolOutput,
  readHumanInputRequest,
} from "./human-input-matcher.ts";

function call(overrides: Partial<ToolCallDisplay> = {}): ToolCallDisplay {
  return {
    toolCallId: "hitl-1",
    toolName: "request_human_input",
    state: "input-available",
    input: {
      question: "Which trip style sounds best to you?",
      options: [
        { label: "Adventure", value: "adventure" },
        { label: "Culture", value: "culture" },
      ],
    },
    ...overrides,
  };
}

function elicitation(overrides: Partial<Elicitation> = {}): Elicitation {
  return {
    id: "elic-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    actionId: "itinerary-result",
    kind: "open-question",
    question: "Which trip style sounds best to you?",
    options: [
      { label: "Adventure", value: "adventure" },
      { label: "Culture", value: "culture" },
    ],
    createdAt: "2026-05-07T19:22:43.285Z",
    expiresAt: "2026-05-07T19:52:43.285Z",
    status: "pending",
    ...overrides,
  };
}

describe("human input matcher", () => {
  it("reads request_human_input question and options from a tool call", () => {
    expect(readHumanInputRequest(call())).toEqual({
      question: "Which trip style sounds best to you?",
      options: [
        { label: "Adventure", value: "adventure" },
        { label: "Culture", value: "culture" },
      ],
    });
  });

  it("rejects non-HITL and malformed calls", () => {
    expect(readHumanInputRequest(call({ toolName: "web_fetch" }))).toBeNull();
    expect(readHumanInputRequest(call({ input: { options: [] } }))).toBeNull();
  });

  it("matches by session/action context when available", () => {
    const match = findMatchingHumanInputElicitation(
      call({ sessionId: "sess-1", actionId: "itinerary-result" }),
      [
        elicitation({ id: "wrong", sessionId: "other" }),
        elicitation({ id: "right" }),
      ],
      "ws-1",
    );

    expect(match?.id).toBe("right");
  });

  it("falls back to question/options when context is absent", () => {
    const match = findMatchingHumanInputElicitation(
      call(),
      [elicitation({ id: "right" })],
      "ws-1",
    );

    expect(match?.id).toBe("right");
  });

  it("does not match another workspace or a different option set", () => {
    expect(
      findMatchingHumanInputElicitation(call(), [
        elicitation({ workspaceId: "ws-2" }),
      ], "ws-1"),
    ).toBeNull();
    expect(
      findMatchingHumanInputElicitation(
        call(),
        [elicitation({ options: [{ label: "Other", value: "other" }] })],
        "ws-1",
      ),
    ).toBeNull();
  });

  it("prefers the newest matching elicitation over older duplicate prompts", () => {
    const match = findMatchingHumanInputElicitation(
      call(),
      [
        elicitation({
          id: "older-pending",
          status: "pending",
          createdAt: "2026-05-07T19:20:00.000Z",
        }),
        elicitation({
          id: "newer-answered",
          status: "answered",
          createdAt: "2026-05-07T19:30:00.000Z",
        }),
      ],
      "ws-1",
    );

    expect(match?.id).toBe("newer-answered");
  });

  it("uses the terminal tool output elicitationId when present", () => {
    const match = findMatchingHumanInputElicitation(
      call({ output: { elicitationId: "terminal-id" } }),
      [
        elicitation({ id: "terminal-id", status: "answered" }),
        elicitation({ id: "pending" }),
      ],
      "ws-1",
    );

    expect(match?.id).toBe("terminal-id");
  });

  it("can read elicitationId from MCP text content output", () => {
    expect(
      readElicitationIdFromToolOutput(
        call({
          output: {
            content: [{
              type: "text",
              text: JSON.stringify({ ok: true, elicitationId: "elc-123" }),
            }],
          },
        }),
      ),
    ).toBe("elc-123");
  });
});
