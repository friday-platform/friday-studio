import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { describe, expect, it } from "vitest";
import { formatWorkspaceSection, type WorkspaceDetails } from "./workspace-chat.agent.ts";

function details(over: Partial<WorkspaceDetails> = {}): WorkspaceDetails {
  return {
    name: "test-workspace",
    description: "A test workspace.",
    agents: [],
    jobs: [],
    signals: [],
    artifacts: [],
    ...over,
  };
}

const REINDEX_SIGNAL = {
  provider: "http",
  description: "rebuild",
  config: { path: "/webhooks/reindex" },
};

const REINDEX_JOB = {
  description: "Rebuild the corpus.",
  triggers: [{ signal: "reindex" }],
  fsm: { initial: "done", states: { done: { type: "final" } } },
};

/** Build a parsed WorkspaceConfig from a partial input.
 *
 * Input is typed as `Record<string, unknown>` rather than
 * `Partial<WorkspaceConfig>` so the inline literal shapes (REINDEX_SIGNAL,
 * REINDEX_JOB) don't have to satisfy the strict discriminated-union
 * shape on `provider` etc. — zod's `parse()` does the validation and
 * returns the precisely-typed `WorkspaceConfig`. */
const config = (over: Record<string, unknown>): WorkspaceConfig =>
  WorkspaceConfigSchema.parse({ version: "1.0", workspace: { name: "x" }, ...over });

describe("formatWorkspaceSection signal display", () => {
  it("points the model at the job tool when one covers the signal (locks tools/qa/live-daemon eval)", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details({ signals: [{ name: "reindex" }] }),
      config({
        signals: { reindex: REINDEX_SIGNAL },
        jobs: { "reindex-knowledge-base": REINDEX_JOB },
      }),
    );

    expect(out).toContain("reindex (use tool: reindex-knowledge-base)");
    expect(out).not.toContain("POST /webhooks/reindex");
  });

  it("falls back to provider-trigger description when no job covers the signal", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details({ signals: [{ name: "reindex" }] }),
      config({
        signals: { reindex: REINDEX_SIGNAL },
        // no jobs at all → must still describe the trigger
      }),
    );

    expect(out).toContain("reindex (POST /webhooks/reindex)");
    expect(out).not.toContain("use tool:");
  });

  it("ignores jobs whose triggers reference a different signal", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details({ signals: [{ name: "reindex" }] }),
      config({
        signals: { reindex: REINDEX_SIGNAL },
        jobs: { "unrelated-job": { ...REINDEX_JOB, triggers: [{ signal: "different-signal" }] } },
      }),
    );

    expect(out).toContain("reindex (POST /webhooks/reindex)");
    expect(out).not.toContain("use tool:");
  });

  it("renders bare signal name when neither config nor jobs are available", () => {
    const out = formatWorkspaceSection("ws_1", details({ signals: [{ name: "reindex" }] }));
    expect(out).toContain("<signals>\nreindex\n</signals>");
  });

  it("maps each signal independently when multiple jobs/signals exist", () => {
    const out = formatWorkspaceSection(
      "ws_1",
      details({ signals: [{ name: "reindex" }, { name: "query" }] }),
      config({
        signals: {
          reindex: REINDEX_SIGNAL,
          query: { ...REINDEX_SIGNAL, config: { path: "/webhooks/query" } },
        },
        jobs: {
          "reindex-knowledge-base": REINDEX_JOB,
          "query-knowledge-base": { ...REINDEX_JOB, triggers: [{ signal: "query" }] },
        },
      }),
    );

    expect(out).toContain("reindex (use tool: reindex-knowledge-base)");
    expect(out).toContain("query (use tool: query-knowledge-base)");
    expect(out).not.toContain("/webhooks/");
  });
});
