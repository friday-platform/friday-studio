import { describe, expect, it } from "vitest";
import { getInputSnapshot } from "../fsm-engine.ts";
import type { Action, Document } from "../types.ts";

describe("getInputSnapshot", () => {
  const emptyDocs = new Map<string, Document>();

  const agentAction: Action = { type: "agent", agentId: "worker", outputTo: "worker_result" };

  it("returns task/config from prepare result when available", () => {
    const prepareResult = { task: "Analyze data", config: { model: "gpt-4" } };

    const snapshot = getInputSnapshot(prepareResult, agentAction, emptyDocs);

    expect(snapshot).toMatchObject({ task: "Analyze data", config: { model: "gpt-4" } });
  });

  it("falls back to request document lookup when no prepare result", () => {
    const docs = new Map<string, Document>([
      [
        "worker-request",
        {
          id: "worker-request",
          type: "request",
          data: { task: "Legacy task", config: { legacy: true } },
        },
      ],
    ]);

    const snapshot = getInputSnapshot(undefined, agentAction, docs);

    expect(snapshot).toMatchObject({ task: "Legacy task", config: { legacy: true } });
  });

  it("returns undefined when neither prepare result nor request document exists", () => {
    const snapshot = getInputSnapshot(undefined, agentAction, emptyDocs);

    expect(snapshot).toBeUndefined();
  });

  it("prefers prepare result over request document when both exist", () => {
    const prepareResult = { task: "New task" };
    const docs = new Map<string, Document>([
      ["worker-request", { id: "worker-request", type: "request", data: { task: "Old task" } }],
    ]);

    const snapshot = getInputSnapshot(prepareResult, agentAction, docs);

    expect(snapshot).toMatchObject({ task: "New task" });
    expect(snapshot).not.toHaveProperty("requestDocId");
  });

  it("returns only task from prepare result when config absent", () => {
    const prepareResult = { task: "Just a task" };

    const snapshot = getInputSnapshot(prepareResult, agentAction, emptyDocs);

    expect(snapshot).toMatchObject({ task: "Just a task" });
    expect(snapshot?.config).toBeUndefined();
  });

  describe("inputFrom", () => {
    const summarizer: Action = {
      type: "agent",
      agentId: "summarizer",
      outputTo: "summary",
      inputFrom: "triage-result",
    };

    it("exposes the named document's data as the agent's task", () => {
      const docs = new Map<string, Document>([
        [
          "triage-result",
          {
            id: "triage-result",
            type: "triage-report",
            data: { response: "5 unread emails: 3 newsletters, 2 utility" },
          },
        ],
      ]);

      const snapshot = getInputSnapshot(undefined, summarizer, docs);

      expect(snapshot?.task).toBe(
        JSON.stringify({ response: "5 unread emails: 3 newsletters, 2 utility" }),
      );
      expect(snapshot?.config).toEqual({
        "triage-result": { response: "5 unread emails: 3 newsletters, 2 utility" },
      });
    });

    it("throws with available document ids when inputFrom is unknown", () => {
      const docs = new Map<string, Document>([
        ["other-doc", { id: "other-doc", type: "x", data: { foo: 1 } }],
      ]);

      expect(() => getInputSnapshot(undefined, summarizer, docs)).toThrow(
        /document 'triage-result' not found.*other-doc/,
      );
    });

    it("throws when the named document has no data", () => {
      const docs = new Map<string, Document>([
        ["triage-result", { id: "triage-result", type: "triage-report", data: {} }],
      ]);
      const dataOnly = new Map<string, unknown>([["triage-result", { id: "triage-result" }]]);

      expect(() => getInputSnapshot(undefined, summarizer, dataOnly)).toThrow(
        /document 'triage-result' has no data/,
      );
      // sanity: with non-empty data the same call returns
      expect(() => getInputSnapshot(undefined, summarizer, docs)).not.toThrow();
    });

    it("prefers prepareResult over inputFrom when both are present", () => {
      const prepareResult = { task: "explicit prepare wins" };
      const docs = new Map<string, Document>([
        [
          "triage-result",
          { id: "triage-result", type: "triage-report", data: { response: "ignored" } },
        ],
      ]);

      const snapshot = getInputSnapshot(prepareResult, summarizer, docs);

      expect(snapshot?.task).toBe("explicit prepare wins");
    });
  });
});
