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
import { beforeEach, describe, expect, it, vi } from "vitest";

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

type GrantsResult = { ok: true; data: string[] } | { ok: false; error: string };

const grantState = vi.hoisted(() => ({
  // Default: empty success. Tests override per-call by reassigning
  // `nextResult` before driving the engine. The mock itself is a vi.fn so
  // tests can also assert on call count (bypass-skip case).
  nextResult: { ok: true as const, data: [] as string[] } as GrantsResult,
}));

const mockListForWorkspace = vi.hoisted(() =>
  vi.fn<(input: { workspaceId: string }) => Promise<GrantsResult>>(() =>
    Promise.resolve(grantState.nextResult),
  ),
);

vi.mock("@atlas/core/elicitations", () => ({
  ToolAccessGrants: {
    listForWorkspace: mockListForWorkspace,
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
  /**
   * If undefined, the LLM action declares no `tools:` array — exercises
   * the `hasNameAllowlist === false` path where buildTools skips per-server
   * narrowing entirely. Pass an empty array to declare `tools: []`
   * explicitly (also no narrowing) or a non-empty array to narrow.
   */
  declaredTools?: string[];
  /**
   * Grant result to be returned by `ToolAccessGrants.listForWorkspace`.
   * Default: empty success. Pass `{ ok: false, error: "..." }` to exercise
   * the warn-and-skip path.
   */
  grants?: GrantsResult;
  workspaceId?: string;
  /**
   * When set, threads `permissions.dangerouslySkipAllowlist: true` into
   * the engine options so `bypassActive` is true inside buildTools. Used
   * to assert the grant query is skipped under bypass.
   */
  bypass?: boolean;
}

async function runActionAndCaptureTools({
  declaredTools,
  grants = { ok: true, data: [] },
  workspaceId = "ws-grant-union",
  bypass = false,
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

  grantState.nextResult = grants;

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
                ...(declaredTools !== undefined && { tools: declaredTools }),
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
    ...(bypass && { jobPermissions: { dangerouslySkipAllowlist: true } }),
  });
  await engine.initialize();
  await engine.signal({ type: "RUN" }, { sessionId: "sess-1", workspaceId });

  return observedToolNames;
}

describe("FSM LLM action — allow_always grants widen the tool surface (#280)", () => {
  beforeEach(() => {
    mockListForWorkspace.mockClear();
  });

  it("unions a granted workspace MCP tool into the action's tool set when it isn't declared", async () => {
    const names = await runActionAndCaptureTools({
      declaredTools: ["workspace-mcp/keep_me"],
      grants: { ok: true, data: ["grant_me"] },
    });
    expect(names).toContain("keep_me");
    expect(names).toContain("grant_me");
  });

  it("does not include a workspace MCP tool when no grant exists", async () => {
    const names = await runActionAndCaptureTools({
      declaredTools: ["workspace-mcp/keep_me"],
      grants: { ok: true, data: [] },
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
      grants: { ok: true, data: ["unloaded_tool"] },
    });
    expect(names).not.toContain("unloaded_tool");
  });

  it("skips the grant query entirely under permissions.dangerouslySkipAllowlist", async () => {
    // Bypass already widens past per-agent narrowing — the grant union
    // would be redundant work and noise in the operator log. Asserting
    // `mockListForWorkspace` was never called locks in that branch.
    const names = await runActionAndCaptureTools({
      declaredTools: ["workspace-mcp/keep_me"],
      grants: { ok: true, data: ["grant_me"] },
      bypass: true,
    });
    expect(mockListForWorkspace).not.toHaveBeenCalled();
    // Bypass surfaces every loaded tool regardless of declaration.
    expect(names).toContain("keep_me");
    expect(names).toContain("grant_me");
  });

  it("warns and continues with an un-widened toolset when the grant store read fails", async () => {
    // KV down, deserialization edge case, etc. — fail safe: no widening,
    // no crash. The declared-only toolset still reaches the LLM so the
    // action can either complete or failStep gracefully.
    const names = await runActionAndCaptureTools({
      declaredTools: ["workspace-mcp/keep_me"],
      grants: { ok: false, error: "kv unavailable" },
    });
    expect(names).toContain("keep_me");
    expect(names).not.toContain("grant_me");
  });

  it("is a no-op when the action declares no tools (no per-server narrowing)", async () => {
    // hasNameAllowlist === false → scoped stays as filtered → every loaded
    // tool already flows through. The grant union should find every
    // granted name already in scoped and add nothing. Most common ad-hoc
    // LLM action shape; previously untested for grant-union behavior.
    const names = await runActionAndCaptureTools({
      declaredTools: undefined,
      grants: { ok: true, data: ["grant_me"] },
    });
    expect(names).toContain("keep_me");
    expect(names).toContain("grant_me");
  });
});
