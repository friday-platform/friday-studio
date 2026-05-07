/**
 * Phase 2.B — FSM document → artifact persistence.
 *
 * Targets the free function `persistFsmSessionArtifacts` (extracted from
 * `WorkspaceRuntime` so this test doesn't have to spin up the full
 * runtime). The vitest global setup (`vitest.setup.ts`) initializes
 * `ArtifactStorage` against a per-worker NATS test server, so calls
 * actually persist and we can read the artifacts back.
 *
 * Each test scopes its writes to a unique `workspaceId` so the suite
 * stays isolated from other tests sharing the same JetStream KV bucket.
 */

import { ArtifactStorage } from "@atlas/core/artifacts/server";
import type { FSMDefinition, Document as FSMDocument } from "@atlas/fsm-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDocumentActionIndex,
  PLUMBING_DOCUMENT_TYPES,
  persistFsmSessionArtifacts,
  synthesizeArtifactSummary,
} from "../runtime.ts";

function makeDefinition(overrides: Partial<FSMDefinition> = {}): FSMDefinition {
  return { id: "test-job", initial: "start", states: { start: { type: "final" } }, ...overrides };
}

describe("persistFsmSessionArtifacts", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an artifact for an analysis-result document with a synthesized summary", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const documents: FSMDocument[] = [
      { id: "analysis", type: "analysis-result", data: { score: 7, finding: "all clear" } },
    ];

    const refs = await persistFsmSessionArtifacts({
      documents,
      definition: makeDefinition(),
      jobName: "scan-inbox",
      workspaceId,
    });

    expect(refs).toHaveLength(1);
    const ref = refs[0];
    if (!ref) throw new Error("expected one ref");
    expect(ref.documentId).toBe("analysis");
    expect(ref.revision).toBe(1);
    expect(ref.artifactId).toMatch(/.+/);

    const fetched = await ArtifactStorage.get({ id: ref.artifactId });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    const artifact = fetched.data;
    expect(artifact).not.toBeNull();
    if (!artifact) return;
    expect(artifact.title).toBe("analysis-result: analysis");
    // I3 structural digest replaces the JSON-truncation fallback.
    expect(artifact.summary).toContain("score: 7");
    expect(artifact.summary).toContain("finding: all clear");
    expect(artifact.source).toBe("fsm-engine:scan-inbox:analysis");
    expect(artifact.workspaceId).toBe(workspaceId);
    expect(artifact.data.mimeType).toBe("application/json");
    expect(artifact.data.originalName).toBe("analysis.json");
  });

  it("uses the action-declared summary when present", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const documents: FSMDocument[] = [
      {
        id: "report",
        type: "report",
        data: { body: "long body that we don't want to surface as a summary" },
      },
    ];
    const definition = makeDefinition({
      states: {
        start: {
          type: "final",
          entry: [
            {
              type: "llm",
              provider: "anthropic",
              model: "claude-opus-4-7",
              prompt: "summarize",
              outputTo: "report",
              summary: "Author-declared summary for the report",
            },
          ],
        },
      },
    });

    const refs = await persistFsmSessionArtifacts({
      documents,
      definition,
      jobName: "weekly-report",
      workspaceId,
    });

    expect(refs).toHaveLength(1);
    const ref = refs[0];
    if (!ref) throw new Error("expected one ref");
    const fetched = await ArtifactStorage.get({ id: ref.artifactId });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok || !fetched.data) return;
    expect(fetched.data.summary).toBe("Author-declared summary for the report");
  });

  it("excludes plumbing document types", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const documents: FSMDocument[] = [
      { id: "t1", type: "state-transition", data: { from: "a", to: "b" } },
      { id: "fs1", type: "fsm-state", data: { name: "running" } },
      { id: "ctx", type: "ChatContext", data: { messages: [] } },
      { id: "sig", type: "signal-payload", data: { trigger: "manual" } },
      { id: "real", type: "analysis-result", data: { ok: true } },
    ];

    const refs = await persistFsmSessionArtifacts({
      documents,
      definition: makeDefinition(),
      jobName: "j",
      workspaceId,
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]?.documentId).toBe("real");
  });

  it("logs and continues when ArtifactStorage.create rejects", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    // Force one failure then let the second call succeed via the real
    // adapter. We can't easily monkey-patch `ArtifactStorage` (frozen
    // facade exporting `const`), so we rely on a doc whose payload is
    // a circular structure — `JSON.stringify` throws, the helper logs
    // and skips that one specifically. Then the second doc succeeds.
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const documents: FSMDocument[] = [
      { id: "bad", type: "report", data: circular },
      { id: "good", type: "summary", data: { ok: true } },
    ];

    const refs = await persistFsmSessionArtifacts({
      documents,
      definition: makeDefinition(),
      jobName: "j",
      workspaceId,
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]?.documentId).toBe("good");
  });
});

describe("buildDocumentActionIndex", () => {
  it("indexes llm and agent actions across entry and transition actions", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "a",
      states: {
        a: {
          entry: [
            {
              type: "llm",
              provider: "p",
              model: "m",
              prompt: "x",
              outputTo: "doc-a",
              summary: "from-entry",
            },
          ],
          on: {
            next: {
              target: "b",
              actions: [
                { type: "agent", agentId: "writer", outputTo: "doc-b", summary: "from-transition" },
              ],
            },
          },
        },
        b: { type: "final" },
      },
    };

    const index = buildDocumentActionIndex(definition);
    expect(index.get("doc-a")?.summary).toBe("from-entry");
    expect(index.get("doc-b")?.summary).toBe("from-transition");
  });

  it("ignores actions without an outputTo and non-llm/agent kinds", () => {
    const definition: FSMDefinition = {
      id: "j",
      initial: "a",
      states: {
        a: {
          entry: [
            { type: "emit", event: "ping" },
            { type: "notification", message: "hi" },
            { type: "llm", provider: "p", model: "m", prompt: "x" }, // no outputTo
          ],
        },
      },
    };

    const index = buildDocumentActionIndex(definition);
    expect(index.size).toBe(0);
  });
});

describe("synthesizeArtifactSummary", () => {
  it("emits a structural digest of top-level scalar fields (I3)", () => {
    expect(synthesizeArtifactSummary({ id: "x", type: "t", data: { a: 1 } })).toBe("a: 1");
  });

  it("truncates long single-field payloads (per-field 80-char cap)", () => {
    const big = { body: "x".repeat(1000) };
    const out = synthesizeArtifactSummary({ id: "x", type: "t", data: big });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to the type tag when scalar/array digest is empty and JSON throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // No scalar/array fields → fall through to JSON.stringify, which
    // throws on the cycle → final fallback returns the type tag.
    expect(synthesizeArtifactSummary({ id: "x", type: "report", data: circular })).toBe("[report]");
  });
});

describe("PLUMBING_DOCUMENT_TYPES", () => {
  it("contains the same entries that getSessionFsmDocuments excludes", () => {
    expect([...PLUMBING_DOCUMENT_TYPES].sort()).toEqual(
      ["ChatContext", "fsm-state", "signal-payload", "state-transition"].sort(),
    );
  });
});
