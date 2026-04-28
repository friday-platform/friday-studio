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

    it("prefers inputFrom over carried-over prepareResult when both are present", () => {
      // prepareResult typically arrives from auto-seeded signal payloads (often
      // empty `{ config: {} }` for cron-triggered jobs). When the action also
      // declares `inputFrom`, the explicit author choice must win — otherwise
      // the agent renders `## Input` from the seeded payload and complains
      // its inputs are missing.
      const prepareResult = { task: "carried-over prepare", config: {} };
      const docs = new Map<string, Document>([
        [
          "triage-result",
          { id: "triage-result", type: "triage-report", data: { response: "actual input" } },
        ],
      ]);

      const snapshot = getInputSnapshot(prepareResult, summarizer, docs);

      expect(snapshot?.task).toBe(JSON.stringify({ response: "actual input" }));
      expect(snapshot?.config).toEqual({ "triage-result": { response: "actual input" } });
    });
  });

  describe("inputFrom (array form)", () => {
    const multi: Action = {
      type: "agent",
      agentId: "summarizer",
      outputTo: "brief",
      inputFrom: ["emails-result", "calendar-result"],
    };

    it("concatenates each doc's data labeled by id, separated by blank lines", () => {
      const docs = new Map<string, Document>([
        [
          "emails-result",
          { id: "emails-result", type: "llm-result", data: { response: "5 unread" } },
        ],
        [
          "calendar-result",
          { id: "calendar-result", type: "llm-result", data: { response: "3 events" } },
        ],
      ]);

      const snapshot = getInputSnapshot(undefined, multi, docs);

      expect(snapshot?.task).toBe(
        `emails-result: ${JSON.stringify({ response: "5 unread" })}\n\n` +
          `calendar-result: ${JSON.stringify({ response: "3 events" })}`,
      );
      expect(snapshot?.config).toEqual({
        "emails-result": { response: "5 unread" },
        "calendar-result": { response: "3 events" },
      });
    });

    it("uses raw string content (no JSON.stringify) when a doc's data is already a string", () => {
      // getInputSnapshot's documents param is typed `Map<string, unknown>` —
      // its only contract on each entry is a `data` field. Use a looser map
      // type here so string-shaped `data` (a real-world case for plain-text
      // outputs) typechecks without widening the production Document type.
      const docs = new Map<string, { id: string; type: string; data: unknown }>([
        ["a", { id: "a", type: "text", data: "hello" }],
        ["b", { id: "b", type: "text", data: "world" }],
      ]);

      const snapshot = getInputSnapshot(
        undefined,
        { type: "agent", agentId: "x", inputFrom: ["a", "b"] } as Action,
        docs,
      );

      expect(snapshot?.task).toBe("a: hello\n\nb: world");
    });

    it("fails loud naming the missing doc when any id in the array is absent", () => {
      const docs = new Map<string, Document>([
        ["emails-result", { id: "emails-result", type: "x", data: { foo: 1 } }],
      ]);

      expect(() => getInputSnapshot(undefined, multi, docs)).toThrow(
        /document 'calendar-result' not found.*emails-result/,
      );
    });

    it("fails loud when any doc in the array has no data", () => {
      const docs = new Map<string, Document>([
        ["emails-result", { id: "emails-result", type: "x", data: { ok: true } }],
        ["calendar-result", { id: "calendar-result", type: "x" }] as unknown as [string, Document],
      ]);

      expect(() => getInputSnapshot(undefined, multi, docs)).toThrow(
        /document 'calendar-result' has no data/,
      );
    });

    it("array of length 1 behaves identically to single-string inputFrom", () => {
      const docs = new Map<string, Document>([
        ["only", { id: "only", type: "x", data: { v: 42 } }],
      ]);

      const arrayShape = getInputSnapshot(
        undefined,
        { type: "agent", agentId: "x", inputFrom: ["only"] } as Action,
        docs,
      );
      const stringShape = getInputSnapshot(
        undefined,
        { type: "agent", agentId: "x", inputFrom: "only" } as Action,
        docs,
      );

      // Both should expose the same `task` (raw doc data) and config map.
      expect(stringShape?.task).toBe(JSON.stringify({ v: 42 }));
      expect(stringShape?.config).toEqual({ only: { v: 42 } });
      // Array form labels its sources, even when there's only one — predictable.
      expect(arrayShape?.task).toBe(`only: ${JSON.stringify({ v: 42 })}`);
      expect(arrayShape?.config).toEqual({ only: { v: 42 } });
    });
  });
});
