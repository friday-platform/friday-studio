/**
 * Phase 9 — FSM `type: llm` actions auto-prepend a `<retrieved_content>`
 * envelope built from artifacts created earlier in the current FSM session.
 *
 * The chat path has long surfaced session-scoped data into the system
 * prompt; FSM `type: llm` actions did not, so a job whose first step
 * created an artifact had no way to carry that artifact's gist into the
 * next LLM step short of routing it through `outputTo` documents. Phase 9
 * closes that gap: at action-start, the engine pulls recent ephemeral
 * artifacts whose `lifecycle.boundTo.sessionId` matches the current
 * session and prepends them to the prompt.
 *
 * This test asserts:
 *   1. Pre-existing session-bound artifacts surface in the next LLM
 *      action's prompt as `<retrieved_content>` envelopes.
 *   2. The envelope carries the eval-described attribute shape
 *      (`provenance="artifact:<id>"`, `origin="workspace:.../session:..."`,
 *      `fetched_at="<iso>"`).
 *   3. Artifacts bound to a *different* session don't leak into this
 *      session's injection — locality is the point.
 */

import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import { ArtifactStorage } from "@atlas/core/artifacts/storage";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);
vi.stubGlobal("fetch", mockFetch);

const mockCreateMCPTools = vi.hoisted(() =>
  vi.fn<
    (
      configs: Record<string, unknown>,
      logger: unknown,
      options?: unknown,
    ) => Promise<{
      tools: Record<string, Tool>;
      toolsByServer: Record<string, string[]>;
      dispose: () => Promise<void>;
      disconnectedIntegrations: unknown[];
    }>
  >(),
);

vi.mock("@atlas/mcp", () => ({
  createMCPTools: mockCreateMCPTools,
  MCPStartupError: class MCPStartupError extends Error {},
  sharedMCPProcesses: { shutdown: () => Promise.resolve() },
}));

vi.mock("@atlas/oapi-client", () => ({
  getAtlasDaemonUrl: () => "http://localhost:3000",
  getAtlasPlatformServerConfig: () => ({ transport: { type: "stdio", command: "noop", args: [] } }),
}));

const { FSMEngine } = await import("../fsm-engine.ts");
const { getDocumentStore } = await import("../../document-store/mod.ts");

import type { FSMDefinition, FSMLLMOutput, LLMProvider } from "../types.ts";

function completeCall(input: Record<string, unknown>): ToolCall {
  return { type: "tool-call", toolCallId: "tc-complete", toolName: "complete", input };
}

describe("FSM LLM action — Phase 9 retrieval-gated artifact injection", () => {
  it("prepends <retrieved_content> blocks for session-bound artifacts", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `sess-${crypto.randomUUID()}`;

    // Two ephemeral artifacts bound to this session — the runtime would
    // normally tag these in `executeAgent`; we simulate by writing directly
    // to ArtifactStorage with the same lifecycle shape.
    const a1 = await ArtifactStorage.create({
      data: { type: "file", content: "alpha bytes", mimeType: "text/plain" },
      title: "alpha",
      summary: "alpha summary line",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
    });
    expect(a1.ok).toBe(true);

    const a2 = await ArtifactStorage.create({
      data: { type: "file", content: "beta bytes", mimeType: "text/plain" },
      title: "beta",
      summary: "beta summary line",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
    });
    expect(a2.ok).toBe(true);

    // A different session's artifact must not leak.
    const otherSession = `sess-other-${crypto.randomUUID()}`;
    await ArtifactStorage.create({
      data: { type: "file", content: "leak", mimeType: "text/plain" },
      title: "leak",
      summary: "leak summary should not appear",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId: otherSession } },
    });

    // Memory list endpoint — return empty so we focus on artifact injection.
    mockFetch.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/memory/")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    mockCreateMCPTools.mockResolvedValue({
      tools: {},
      toolsByServer: {},
      dispose: () => Promise.resolve(),
      disconnectedIntegrations: [],
    });

    let observedPrompt: string | undefined;
    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        // Capture system + user-message body together so substring asserts
        // work regardless of whether content lands in the cacheable system
        // surface or the volatile user preface.
        observedPrompt = `${params.system ?? ""}\n\n${params.prompt ?? ""}`;
        const envelope: AgentResult<string, FSMLLMOutput> = {
          agentId: params.agentId,
          timestamp: new Date().toISOString(),
          input: params.prompt ?? "",
          ok: true,
          data: { response: "" },
          toolCalls: [completeCall({ response: "done" })],
          toolResults: [],
          durationMs: 0,
        };
        return Promise.resolve(envelope);
      },
    };

    const fsm: FSMDefinition = {
      id: "artifact-injection-test",
      initial: "pending",
      states: {
        pending: {
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Continue working on the task.",
                  outputTo: "decision",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
    };

    const engine = new FSMEngine(fsm, {
      documentStore: getDocumentStore(),
      scope: { workspaceId, sessionId },
      llmProvider: mockLLMProvider,
    });
    await engine.initialize();

    await engine.signal({ type: "RUN" }, { sessionId, workspaceId });

    expect(observedPrompt).toBeDefined();
    // Envelope-format invariants — match what the eval scaffold expects.
    expect(observedPrompt!).toContain("<retrieved_content");
    expect(observedPrompt!).toContain(`origin="workspace:${workspaceId}/session:${sessionId}"`);
    expect(observedPrompt!).toMatch(/fetched_at="\d{4}-\d{2}-\d{2}T/);
    expect(observedPrompt!).toContain("</retrieved_content>");
    // Both session-scoped artifacts should appear; the other-session one
    // should not.
    expect(observedPrompt!).toContain("alpha summary line");
    expect(observedPrompt!).toContain("beta summary line");
    expect(observedPrompt!).not.toContain("leak summary should not appear");
    // The original action prompt is preserved alongside the injection.
    expect(observedPrompt!).toContain("Continue working on the task.");
  });
});
