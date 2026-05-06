/**
 * Phase 2.C — job-complete payload shape: artifactIds + summary.
 *
 * Targets the post-completion summary-synthesis fallback (`synthesizeFallbackSummary`)
 * and the lookup glue (terminal-state action.summary preference) used by
 * `WorkspaceRuntime.getSessionJobResult`. Pure-function tests — they don't
 * spin up the full runtime; the runtime-level wiring is exercised by the
 * existing artifact-persist integration test plus the cascade-stream tests
 * that confirm the dispatcher contract.
 */

import type { FSMDefinition } from "@atlas/fsm-engine";
import { describe, expect, it } from "vitest";
import {
  buildDocumentActionIndex,
  buildDocumentTerminalIndex,
  synthesizeFallbackSummary,
} from "../runtime.ts";

describe("synthesizeFallbackSummary", () => {
  it("returns the JSON-stringified data of the last non-plumbing document", () => {
    const docs = [
      { id: "transition-1", type: "state-transition", data: { from: "a", to: "b" } },
      { id: "report", type: "report", data: { ok: true, items: 3 } },
    ];
    expect(synthesizeFallbackSummary(docs)).toBe('{"ok":true,"items":3}');
  });

  it("skips plumbing documents and picks the last non-plumbing one", () => {
    const docs = [
      { id: "early", type: "early-result", data: { phase: 1 } },
      { id: "later", type: "later-result", data: { phase: 2 } },
      { id: "transition", type: "state-transition", data: { from: "a", to: "b" } },
    ];
    // `later-result` is the last non-plumbing doc; transition is filtered out.
    expect(synthesizeFallbackSummary(docs)).toBe('{"phase":2}');
  });

  it("returns an empty string when only plumbing documents are present", () => {
    const docs = [
      { id: "t1", type: "state-transition", data: { from: "a", to: "b" } },
      { id: "fs1", type: "fsm-state", data: { name: "running" } },
    ];
    expect(synthesizeFallbackSummary(docs)).toBe("");
  });

  it("returns an empty string for an empty document list", () => {
    expect(synthesizeFallbackSummary([])).toBe("");
  });

  it("truncates long payloads to ~300 chars (delegates to synthesizeArtifactSummary)", () => {
    const docs = [{ id: "big", type: "report", data: { body: "x".repeat(1000) } }];
    const out = synthesizeFallbackSummary(docs);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("getSessionJobResult lookup glue", () => {
  // The full method lives on WorkspaceRuntime; these tests cover the pure
  // building blocks (terminal-state index + action index) in the
  // arrangement the method itself uses to pick a summary.

  it("prefers a terminal-state action's declared `summary` field over synthesized", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "start",
      states: {
        start: {
          entry: [
            {
              type: "llm",
              provider: "p",
              model: "m",
              prompt: "draft",
              outputTo: "draft-doc",
              summary: "intermediate (non-terminal)",
            },
          ],
          on: { next: { target: "done" } },
        },
        done: {
          type: "final",
          entry: [
            {
              type: "llm",
              provider: "p",
              model: "m",
              prompt: "finalize",
              outputTo: "final-doc",
              summary: "terminal-state declared summary",
            },
          ],
        },
      },
    };

    const terminalIds = buildDocumentTerminalIndex(definition);
    const actionIndex = buildDocumentActionIndex(definition);

    expect(terminalIds.has("final-doc")).toBe(true);
    expect(terminalIds.has("draft-doc")).toBe(false);
    expect(actionIndex.get("final-doc")?.summary).toBe("terminal-state declared summary");
    // Non-terminal action also has a `summary`, but the lookup must skip it
    // because it isn't on a terminal state.
    expect(actionIndex.get("draft-doc")?.summary).toBe("intermediate (non-terminal)");
  });

  it("returns no terminal id when the FSM has no terminal-state action with outputTo", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "a",
      states: {
        a: { entry: [{ type: "llm", provider: "p", model: "m", prompt: "x", outputTo: "doc-a" }] },
      },
    };
    const terminalIds = buildDocumentTerminalIndex(definition);
    expect(terminalIds.size).toBe(0);
  });
});
