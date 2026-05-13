/**
 * Issue #280 — `allow_always` grants are unioned into the action's
 * tool surface so the LLM can actually call previously-approved tools
 * in subsequent actions. Without this wiring, `request_tool_access`
 * was an approval signal with no path back to the LLM's static
 * `streamText` tools array.
 *
 * This suite mocks at three boundaries:
 *   - `@atlas/mcp.createMCPTools` — returns a fixed tool surface so we
 *     can assert which subset the engine actually forwards to the LLM.
 *   - `@atlas/oapi-client` — sidesteps env / daemon URL reads.
 *   - `@atlas/core/elicitations.ToolAccessGrants` — control the grant
 *     list returned for the workspace under test.
 *
 * The assertions inspect the tool names that `llmProvider.call`
 * receives. That's the same surface `streamText` uses in production,
 * which is exactly the read path #280 says was unreachable from the
 * grant store.
 */

import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
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

const grantState = vi.hoisted(() => ({
  grants: [] as string[],
  reset() {
    this.grants = [];
  },
}));

vi.mock("@atlas/core/elicitations", () => ({
  ToolAccessGrants: {
    listForWorkspace: () => Promise.resolve({ ok: true as const, data: [...grantState.grants] }),
    hasGrant: () => Promise.resolve({ ok: true as const, data: false }),
    grantAlways: () => Promise.resolve({ ok: false as const, error: "not used in this suite" }),
  },
}));

const { FSMEngine } = await import("../fsm-engine.ts");
const { getDocumentStore } = await import("../../document-store/mod.ts");

import type { FSMDefinition, FSMLLMOutput, LLMProvider } from "../types.ts";

function completeCall(input: Record<string, unknown>): ToolCall {
  return { type: "tool-call", toolCallId: "tc-complete", toolName: "complete", input };
}

function fakeTool(name: string): Tool {
  return {
    description: `mock ${name}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } as never,
    execute: (() => Promise.resolve({ name })) as Tool["execute"],
  };
}

interface RunOptions {
  declaredTools: string[];
  grants: string[];
  workspaceId?: string;
}

async function runActionAndCaptureTools({
  declaredTools,
  grants,
  workspaceId = "ws-grant-union",
}: RunOptions): Promise<string[]> {
  mockFetch.mockImplementation(() => Promise.resolve(new Response("not found", { status: 404 })));

  // The narrowing path that #280 fixes only affects workspace MCP servers —
  // platform tools are ambient and always pass through. Use a synthetic
  // workspace MCP server to exercise the actual gap.
  const workspaceTools = ["keep_me", "grant_me"];
  mockCreateMCPTools.mockResolvedValue({
    tools: Object.fromEntries(workspaceTools.map((n) => [n, fakeTool(n)])),
    toolsByServer: { "workspace-mcp": workspaceTools },
    dispose: () => Promise.resolve(),
    disconnectedIntegrations: [],
  });

  grantState.grants = grants;

  let observedToolNames: string[] = [];
  const mockLLMProvider: LLMProvider = {
    call: (params) => {
      observedToolNames = Object.keys(params.tools as Record<string, Tool>);
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
    // Document store state is keyed by FSM id; reusing the same id across
    // tests in a single file replays prior state into engine.initialize().
    // Random id per invocation keeps the suite truly per-test isolated.
    id: `grant-union-test-${crypto.randomUUID()}`,
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
                tools: declaredTools,
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
    scope: { workspaceId, sessionId: "sess-1" },
    llmProvider: mockLLMProvider,
  });
  await engine.initialize();
  await engine.signal({ type: "RUN" }, { sessionId: "sess-1", workspaceId });

  return observedToolNames;
}

describe("FSM LLM action — allow_always grants widen the tool surface (#280)", () => {
  it("unions a granted workspace MCP tool into the action's tool set when it isn't declared", async () => {
    const names = await runActionAndCaptureTools({
      declaredTools: ["workspace-mcp/keep_me"],
      grants: ["grant_me"],
    });
    expect(names).toContain("keep_me");
    expect(names).toContain("grant_me");
  });

  it("does not include a workspace MCP tool when no grant exists", async () => {
    const names = await runActionAndCaptureTools({
      declaredTools: ["workspace-mcp/keep_me"],
      grants: [],
    });
    expect(names).toContain("keep_me");
    expect(names).not.toContain("grant_me");
  });

  it("does not surface a granted tool that isn't in the loaded MCP surface", async () => {
    // Defense in depth: grants only widen up to what `filtered` already
    // contains. A grant for an unloaded tool (server not connected this
    // action, or tool removed) doesn't materialize anything.
    const names = await runActionAndCaptureTools({
      declaredTools: ["workspace-mcp/keep_me"],
      grants: ["unloaded_tool"],
    });
    expect(names).not.toContain("unloaded_tool");
  });
});
