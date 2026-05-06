/**
 * Phase 3 — scrubber wired into FSM `type: llm` action tool calls.
 *
 * The chat path has long lifted oversized MCP tool results to artifacts before
 * they hit the AI SDK message buffer (see `@atlas/core/artifacts/scrubber`).
 * FSM-side tool calls did not — so any agent that pulled bulky data (gmail
 * batch fetch, run_code stdout) bloated its own context every step.
 *
 * This test asserts the wiring: when an LLM action declares `tools:`, the
 * call to `createMCPTools` carries a `scrubResult` post-processor, and that
 * post-processor lifts oversized base64 to an artifact ref before returning
 * the result the LLM sees.
 *
 * The test mocks at three boundaries:
 *   - `@atlas/mcp.createMCPTools` — captures the options to assert wiring,
 *     and returns a tool that produces an oversized payload so we can
 *     observe the scrubber actually running on the result.
 *   - `@atlas/oapi-client` — avoid pulling in the platform server config
 *     (it tries to read env vars / build a daemon URL otherwise).
 *   - `fetch` — the scrubber posts to /artifacts/storage; we stub the
 *     successful response shape so the lift completes.
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);
vi.stubGlobal("fetch", mockFetch);

// Capture createMCPTools options + provide a single tool whose execute()
// returns an oversized base64 payload. The scrubber runs on the payload
// before it reaches the LLM, so the LLM provider mock will see the lifted
// ref string instead of the original blob.
const mockCreateMCPTools = vi.hoisted(() =>
  vi.fn<
    (
      configs: Record<string, unknown>,
      logger: unknown,
      options?: {
        signal?: AbortSignal;
        toolPrefix?: string;
        scrubResult?: (
          result: unknown,
          ctx: { serverId: string; toolName: string },
        ) => Promise<unknown>;
      },
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

const SIZE_THRESHOLD_CHARS = 4 * 1024;

describe("FSM LLM action — scrubber wiring (Phase 3)", () => {
  it("passes scrubResult into createMCPTools and lifts oversized base64", async () => {
    // Capture what the LLM provider receives so we can assert the scrubber
    // ran on the tool output before it landed in the message buffer.
    const llmReceivedToolResults: unknown[] = [];

    // Route fetches per URL. The artifact upload (POST /artifacts/storage)
    // gets the success envelope; Phase 5's auto-injection of memory blocks
    // means the LLM action also fires `GET /api/memory/<workspaceId>`,
    // which we 404 to keep the test focused on scrubber wiring. Using
    // `mockImplementation` instead of `mockResolvedValue` because each
    // fetch needs its own Response (Response bodies are stream-once).
    mockFetch.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/memory/")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            artifact: {
              id: "art_fsm_lift",
              type: "file",
              revision: 1,
              data: { type: "file", contentRef: "x", size: 24_000, mimeType: "application/pdf" },
              title: "x",
              summary: "y",
              createdAt: new Date().toISOString(),
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    // The mocked MCP server exposes one tool. createMCPTools wraps the
    // tool's execute with the caller's scrubResult — same contract as the
    // real implementation in `packages/mcp/src/create-mcp-tools.ts`.
    mockCreateMCPTools.mockImplementation((_configs, _logger, options) => {
      const rawTool: Tool = {
        description: "test tool",
        inputSchema: { type: "object", properties: {}, additionalProperties: false } as never,
        execute: () =>
          Promise.resolve({
            content: [
              {
                type: "text",
                // Oversized base64 blob — scrubber must lift this.
                text: `here goes: ${"A".repeat(SIZE_THRESHOLD_CHARS + 200)} ...done`,
              },
            ],
          }),
      };
      // Cast through Tool["execute"] to dodge AI SDK's deeply-generic
      // ToolExecuteFunction signature; runtime shape is what we exercise.
      const wrappedExecute = options?.scrubResult
        ? ((async (args: Parameters<NonNullable<Tool["execute"]>>[0], ctx) => {
            const result = await rawTool.execute!(args, ctx);
            return await options.scrubResult!(result, {
              serverId: "test-server",
              toolName: "fetch_thing",
            });
          }) as Tool["execute"])
        : rawTool.execute;
      const wrapped: Tool = { ...rawTool, execute: wrappedExecute };
      return Promise.resolve({
        tools: { fetch_thing: wrapped },
        toolsByServer: { "test-server": ["fetch_thing"] },
        dispose: () => Promise.resolve(),
        disconnectedIntegrations: [],
      });
    });

    // LLM provider mock: invoke the wrapped tool once so the scrubber path
    // executes, then return a final response. The captured toolResults
    // surface what actually reached the model.
    const mockLLMProvider: LLMProvider = {
      call: async (params) => {
        const tool = (params.tools as Record<string, Tool>)["fetch_thing"];
        // Exercise the tool — this is where the scrubber wrapper fires.
        const output = await tool!.execute!({}, { toolCallId: "tc1", messages: [] } as never);
        llmReceivedToolResults.push(output);

        const envelope: AgentResult<string, FSMLLMOutput> = {
          agentId: params.agentId,
          timestamp: new Date().toISOString(),
          input: params.prompt ?? "",
          ok: true,
          data: { response: "done" },
          toolCalls: [{ type: "tool-call", toolCallId: "tc1", toolName: "fetch_thing", input: {} }],
          toolResults: [
            { type: "tool-result", toolCallId: "tc1", toolName: "fetch_thing", input: {}, output },
          ],
          durationMs: 0,
        };
        return envelope;
      },
    };

    const fsm: FSMDefinition = {
      id: "scrubber-integration-test",
      initial: "pending",
      states: {
        pending: {
          on: {
            RUN_LLM: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "fetch the thing",
                  tools: ["test-server"],
                  outputTo: "output",
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
      scope: { workspaceId: `ws-${crypto.randomUUID()}`, sessionId: `sess-${crypto.randomUUID()}` },
      llmProvider: mockLLMProvider,
      mcpServerConfigs: {
        "test-server": { transport: { type: "stdio", command: "noop", args: [] } } as never,
      },
    });
    await engine.initialize();

    await engine.signal(
      { type: "RUN_LLM" },
      { sessionId: "sess-active", workspaceId: "ws-active" },
    );

    // 1) createMCPTools was called with a scrubResult function.
    expect(mockCreateMCPTools).toHaveBeenCalled();
    const lastCall = mockCreateMCPTools.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const opts = lastCall?.[2];
    expect(opts?.scrubResult).toBeDefined();
    expect(typeof opts?.scrubResult).toBe("function");

    // 2) The artifact upload happened — proof the scrubber actually ran on
    //    the oversized blob (vs being passed but never invoked).
    expect(mockFetch).toHaveBeenCalled();

    // 3) The result that reached the LLM has the lift marker, not the
    //    original base64. This is the user-visible win: the model never
    //    sees the bytes, just a short ref.
    expect(llmReceivedToolResults).toHaveLength(1);
    const observed = llmReceivedToolResults[0] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(observed.content[0]?.text).toMatch(/artifact art_fsm_lift/);
    expect(observed.content[0]?.text).not.toContain("A".repeat(SIZE_THRESHOLD_CHARS));
  });
});
