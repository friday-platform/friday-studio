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
});
