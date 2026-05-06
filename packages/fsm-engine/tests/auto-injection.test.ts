/**
 * Phase 5 — FSM `type: llm` actions auto-inject memory + artifact tools and
 * auto-prepend recent memory blocks to the action prompt.
 *
 * The chat path has long composed memory blocks (`<memory workspace="..." />`)
 * into its system prompt and exposed memory_save / memory_read / artifacts_*
 * tools regardless of any per-call tool list. FSM-side LLM actions did not —
 * an action whose `tools:` array omitted `memory_save` couldn't save memory,
 * even though the workspace had a memory store declared. This test asserts
 * the parity wiring:
 *
 *   1. With NO `tools:` declared on the action, the platform-tool surface
 *      (memory_save, memory_read, artifacts_create, etc.) still reaches the
 *      LLM call. Equivalently: `createMCPTools` is invoked with at least
 *      atlas-platform configured, and those tools end up in the `tools` map
 *      handed to `llmProvider.call`.
 *   2. The action's prompt includes a `<memory workspace="..." store="...">`
 *      envelope built from the daemon's `/api/memory/...` endpoints —
 *      same composer the chat path uses.
 */

import type { AgentResult } from "@atlas/agent-sdk";
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Note (2026-05-06 review): this suite verifies that the FSM LLM action
// path forwards platform tools returned by createMCPTools to the LLM
// and that atlas-platform is in the connected configs. It does NOT
// verify that the *real* atlas-platform MCP server actually exposes a
// tool named `memory_save` — that's an integration concern covered by
// the eval suite. If platform's tool naming changes (e.g. `mem_save`),
// production breaks but these tests still pass because they stub
// createMCPTools.
describe("FSM LLM action — forwards configured platform tools to LLM (Phase 5)", () => {
  it("exposes memory_save without action.tools declaring it, and prepends <memory> blocks to the prompt", async () => {
    // Daemon HTTP mock: list one narrative store with one entry.
    mockFetch.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/api/memory/ws-active")) {
        return Promise.resolve(
          jsonResponse([{ workspaceId: "ws-active", name: "decisions", kind: "narrative" }]),
        );
      }
      if (url.includes("/api/memory/ws-active/narrative/decisions")) {
        return Promise.resolve(
          jsonResponse([
            {
              id: "e1",
              text: "Always escalate billing issues to ops first.",
              createdAt: "2026-05-04T12:00:00Z",
            },
          ]),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const memorySaveCalls: Array<Record<string, unknown>> = [];
    const memorySaveTool: Tool = {
      description: "Save an entry to a memory store.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          memoryName: { type: "string" },
          text: { type: "string" },
        },
        required: ["workspaceId", "memoryName", "text"],
        additionalProperties: false,
      } as never,
      execute: ((args: Record<string, unknown>) => {
        memorySaveCalls.push(args);
        return Promise.resolve({ saved: true });
      }) as Tool["execute"],
    };

    mockCreateMCPTools.mockResolvedValue({
      tools: { memory_save: memorySaveTool },
      toolsByServer: { "atlas-platform": ["memory_save"] },
      dispose: () => Promise.resolve(),
      disconnectedIntegrations: [],
    });

    let observedPrompt: string | undefined;
    let observedToolNames: string[] | undefined;
    const mockLLMProvider: LLMProvider = {
      call: async (params) => {
        observedPrompt = params.prompt;
        observedToolNames = Object.keys(params.tools as Record<string, Tool>);

        const tool = (params.tools as Record<string, Tool>)["memory_save"];
        if (tool?.execute) {
          await tool.execute(
            { workspaceId: "ignored-by-wrapper", memoryName: "decisions", text: "new decision" },
            { toolCallId: "tc1", messages: [] } as never,
          );
        }

        const envelope: AgentResult<string, FSMLLMOutput> = {
          agentId: params.agentId,
          timestamp: new Date().toISOString(),
          input: params.prompt ?? "",
          ok: true,
          data: { response: "done" },
          toolCalls: [],
          toolResults: [],
          durationMs: 0,
        };
        return envelope;
      },
    };

    // FSM definition: an LLM action with NO `tools:` declared. Auto-injection
    // is what makes memory_save reachable.
    const fsm: FSMDefinition = {
      id: "auto-injection-test",
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
                  prompt: "Decide whether to remember the user's preference.",
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
      scope: { workspaceId: "ws-active", sessionId: "sess-1" },
      llmProvider: mockLLMProvider,
    });
    await engine.initialize();

    await engine.signal({ type: "RUN" }, { sessionId: "sess-1", workspaceId: "ws-active" });

    // 1) atlas-platform was connected even though action.tools is empty.
    expect(mockCreateMCPTools).toHaveBeenCalled();
    const lastCall = mockCreateMCPTools.mock.calls.at(-1);
    const configs = lastCall?.[0] as Record<string, unknown> | undefined;
    expect(configs).toBeDefined();
    expect(configs!["atlas-platform"]).toBeDefined();

    // 2) memory_save reached the LLM tools map without being declared.
    expect(observedToolNames).toContain("memory_save");
    expect(observedToolNames).toContain("failStep");

    // 3) Memory blocks were prepended to the prompt.
    expect(observedPrompt).toBeDefined();
    expect(observedPrompt!).toContain('<memory workspace="ws-active" store="decisions">');
    expect(observedPrompt!).toContain("Always escalate billing issues to ops first.");
    expect(observedPrompt!).toContain("Decide whether to remember the user's preference.");

    // 4) The auto-injected tool is actually invokable end-to-end.
    expect(memorySaveCalls).toHaveLength(1);
    // wrapPlatformToolsWithScope rewrites workspaceId from the engine scope
    // — defense-in-depth guarantee, asserted here so a regression in the
    // injection wrapper surfaces this test (not a prod incident).
    expect(memorySaveCalls[0]?.workspaceId).toBe("ws-active");
    expect(memorySaveCalls[0]?.text).toBe("new decision");
  });
});
