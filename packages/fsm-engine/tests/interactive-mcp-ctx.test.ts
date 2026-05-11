/**
 * v8 design decision 18 — Phase 3 plumbing.
 *
 * The fsm-engine LLM-action path calls `createMCPToolsWithRetry`, passing an
 * `InteractiveContext` only when the signal carries `sessionInteractive ===
 * true`. This file pins that contract: an interactive session gets a context
 * built from (workspaceId, sessionId, actionId, jobTimeoutMs,
 * sessionAbortSignal); a non-interactive session passes `undefined` so
 * transient credential failures throw synchronously instead of raising an
 * elicitation.
 */

import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);
vi.stubGlobal("fetch", mockFetch);
mockFetch.mockImplementation(() => Promise.resolve(new Response("not found", { status: 404 })));

// Capture both names. `createMCPTools` mock returns a no-op result;
// `createMCPToolsWithRetry` captures all four arguments so the assertions
// below can interrogate the `interactiveCtx` shape per call.
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

const mockCreateMCPToolsWithRetry = vi.hoisted(() => vi.fn());

vi.mock("@atlas/mcp", () => ({
  createMCPTools: mockCreateMCPTools,
  createMCPToolsWithRetry: mockCreateMCPToolsWithRetry,
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

function makeProvider(): LLMProvider {
  return {
    call: (params) => {
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
}

function makeFsm(): FSMDefinition {
  return {
    id: "interactive-mcp-ctx-test",
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
                prompt: "noop",
                outputTo: "out",
              },
            ],
          },
        },
      },
      done: { type: "final" },
    },
  };
}

describe("fsm-engine LLM action — createMCPToolsWithRetry interactiveCtx gating (v8 decision 18)", () => {
  it("passes interactiveCtx when signal.context.sessionInteractive === true", async () => {
    mockCreateMCPToolsWithRetry.mockReset();
    mockCreateMCPToolsWithRetry.mockResolvedValue({
      tools: {},
      toolsByServer: {},
      dispose: () => Promise.resolve(),
      disconnected: [],
    });

    const engine = new FSMEngine(makeFsm(), {
      documentStore: getDocumentStore(),
      scope: { workspaceId: "ws-i", sessionId: "sess-i" },
      llmProvider: makeProvider(),
      jobTimeoutMs: 30_000,
    });
    await engine.initialize();

    const ac = new AbortController();
    await engine.signal(
      { type: "RUN" },
      {
        sessionId: "sess-i",
        workspaceId: "ws-i",
        abortSignal: ac.signal,
        sessionInteractive: true,
      },
    );

    expect(mockCreateMCPToolsWithRetry).toHaveBeenCalled();
    const lastCall = mockCreateMCPToolsWithRetry.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const interactiveCtx = lastCall?.[3] as
      | {
          workspaceId: string;
          sessionId: string;
          actionId?: string;
          jobTimeoutMs?: number;
          sessionAbortSignal?: AbortSignal;
        }
      | undefined;
    expect(interactiveCtx).toBeDefined();
    expect(interactiveCtx?.workspaceId).toBe("ws-i");
    expect(interactiveCtx?.sessionId).toBe("sess-i");
    expect(interactiveCtx?.jobTimeoutMs).toBe(30_000);
    expect(interactiveCtx?.sessionAbortSignal).toBe(ac.signal);
  });

  it("omits interactiveCtx (undefined) when sessionInteractive is false", async () => {
    mockCreateMCPToolsWithRetry.mockReset();
    mockCreateMCPToolsWithRetry.mockResolvedValue({
      tools: {},
      toolsByServer: {},
      dispose: () => Promise.resolve(),
      disconnected: [],
    });

    const engine = new FSMEngine(makeFsm(), {
      documentStore: getDocumentStore(),
      scope: { workspaceId: "ws-cron", sessionId: "sess-cron" },
      llmProvider: makeProvider(),
    });
    await engine.initialize();

    await engine.signal(
      { type: "RUN" },
      { sessionId: "sess-cron", workspaceId: "ws-cron", sessionInteractive: false },
    );

    expect(mockCreateMCPToolsWithRetry).toHaveBeenCalled();
    const lastCall = mockCreateMCPToolsWithRetry.mock.calls.at(-1);
    expect(lastCall?.[3]).toBeUndefined();
  });

  it("omits interactiveCtx (undefined) when sessionInteractive is unset", async () => {
    mockCreateMCPToolsWithRetry.mockReset();
    mockCreateMCPToolsWithRetry.mockResolvedValue({
      tools: {},
      toolsByServer: {},
      dispose: () => Promise.resolve(),
      disconnected: [],
    });

    const engine = new FSMEngine(makeFsm(), {
      documentStore: getDocumentStore(),
      scope: { workspaceId: "ws-unset", sessionId: "sess-unset" },
      llmProvider: makeProvider(),
    });
    await engine.initialize();

    await engine.signal({ type: "RUN" }, { sessionId: "sess-unset", workspaceId: "ws-unset" });

    expect(mockCreateMCPToolsWithRetry).toHaveBeenCalled();
    const lastCall = mockCreateMCPToolsWithRetry.mock.calls.at(-1);
    expect(lastCall?.[3]).toBeUndefined();
  });
});
