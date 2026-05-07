/**
 * Phase 3 (pt1) wired the scrubber into FSM `type: llm` action tool calls
 * at the MCP-tool-result boundary, lifting oversized MCP tool results to
 * artifacts BEFORE they hit the AI SDK message buffer.
 *
 * **N4 (melodic-strolling-seal-pt3) reversed that wiring.** For
 * consume-immediately actions (inbox-fetcher: gmail batch → emit JSON),
 * the producer LLM had to round-trip through `artifacts_get` to recover
 * bytes it just produced, and frequently bailed into prose. The lift's
 * value is persistence + cross-consumer compactness, not producer-LLM
 * context shrinkage; it now lives at the side-channel population point
 * via `liftToolResultsForPersist` (after streamText returns, before
 * session events emit).
 *
 * This test inverts the original contract assertion: when an LLM action
 * declares `tools:`, the call to `createMCPTools` carries NO
 * `scrubResult` post-processor. The producer LLM sees full bytes; the
 * persistence-side lift is exercised end-to-end via the live-daemon
 * harness rather than mocked here.
 *
 * The test mocks two boundaries (down from three pre-N4):
 *   - `@atlas/mcp.createMCPTools` — captures the options to assert the
 *     `scrubResult` field is absent.
 *   - `@atlas/oapi-client` — avoid pulling in the platform server config
 *     (it tries to read env vars / build a daemon URL otherwise).
 */

import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
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

function completeCall(input: Record<string, unknown>): ToolCall {
  return { type: "tool-call", toolCallId: "tc-complete", toolName: "complete", input };
}

const SIZE_THRESHOLD_CHARS = 4 * 1024;

// Note (2026-05-06 review): this suite mocks `@atlas/mcp`'s createMCPTools
// — the mocked wrapper itself implements the `wrappedExecute = scrubResult
// ? ... : ...` branch. So an assertion that "lifted base64 ends up as a
// ref" only proves that the test's own wrapper invokes the scrubResult
// callback, not that the production createMCPTools at
// `packages/mcp/src/create-mcp-tools.ts` calls it. A regression in
// production createMCPTools that silently dropped the scrubResult call
// would still pass these tests.
//
// The genuinely useful assertion in this suite is "createMCPTools is
// called with scrubResult set" (the wiring contract). That part is
// real. The "lifted to artifact ref" payload-shape part is tautological
// against the test's own wrapper. A future pass that swaps in the real
// createMCPTools against a stub MCP server fixture would make the
// payload-shape assertions meaningful.
describe("FSM LLM action — scrubber wiring (N4: lift moved off MCP boundary)", () => {
  it("does NOT pass scrubResult into createMCPTools (N4 — lift moved to post-streamText)", async () => {
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
          data: { response: "" },
          toolCalls: [
            { type: "tool-call", toolCallId: "tc1", toolName: "fetch_thing", input: {} },
            completeCall({ response: "done" }),
          ],
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

    // N4 — createMCPTools is called WITHOUT a scrubResult function.
    // The lift moved off the MCP boundary; the producer LLM sees full
    // bytes during the streamText loop. End-to-end lift behavior is
    // covered by the live-daemon harness scenarios.
    expect(mockCreateMCPTools).toHaveBeenCalled();
    const lastCall = mockCreateMCPTools.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const opts = lastCall?.[2];
    expect(opts?.scrubResult).toBeUndefined();

    // The LLM observed full bytes (no lift marker, no artifact upload
    // mid-call). Proves the producer LLM is no longer round-tripped
    // through artifacts_get for its own tool results.
    expect(llmReceivedToolResults).toHaveLength(1);
    const observed = llmReceivedToolResults[0] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(observed.content[0]?.text).not.toMatch(/artifact art_fsm_lift/);
    expect(observed.content[0]?.text).toContain("A".repeat(SIZE_THRESHOLD_CHARS));
  });
});
