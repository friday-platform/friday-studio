import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getDocumentStore } from "../../document-store/node.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition, FSMLLMOutput, LLMProvider } from "../types.ts";

/**
 * Creates an LLM result envelope with a `complete` tool call,
 * simulating an LLM that called the `complete` tool with given args.
 */
function completeToolResult(
  args: Record<string, unknown>,
  agentId = "test",
  prompt = "test prompt",
): AgentResult<string, FSMLLMOutput> {
  const toolCalls: ToolCall[] = [
    { type: "tool-call", toolCallId: "mock-complete", toolName: "complete", input: args },
  ];

  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data: { response: "" },
    toolCalls,
    durationMs: 0,
  };
}

/**
 * Creates an FSM engine with a mock LLM provider that returns
 * a single `complete` tool call with the given args.
 */
async function createLLMEngineWithCompleteOutput(completeArgs: Record<string, unknown>) {
  const fsm: FSMDefinition = {
    id: "unstringify-test",
    initial: "pending",
    states: {
      pending: {
        documents: [{ id: "result", type: "Output", data: {} }],
        on: {
          RUN: {
            target: "done",
            actions: [
              {
                type: "llm",
                provider: "test",
                model: "test-model",
                prompt: "Do the thing",
                outputTo: "result",
              },
            ],
          },
        },
      },
      done: { type: "final" },
    },
    documentTypes: {
      Output: { type: "object", properties: { title: { type: "string" }, pages: {} } },
    },
  };

  const store = getDocumentStore();
  const scope = {
    workspaceId: `test-${crypto.randomUUID()}`,
    sessionId: `test-session-${crypto.randomUUID()}`,
  };

  const mockLLMProvider: LLMProvider = {
    call: (params) =>
      Promise.resolve(completeToolResult(completeArgs, params.agentId, params.prompt)),
  };

  const engine = new FSMEngine(fsm, { documentStore: store, scope, llmProvider: mockLLMProvider });
  await engine.initialize();

  return { engine, store, scope };
}

describe("FSM Engine - unstringify nested JSON in LLM complete output", () => {
  it("parses stringified JSON array in complete tool output before storing", async () => {
    const { engine } = await createLLMEngineWithCompleteOutput({
      title: "Test Report",
      pages: '[{"id":"1","name":"intro"},{"id":"2","name":"body"}]',
    });

    await engine.signal({ type: "RUN" });

    expect(engine.results.result).toEqual({
      title: "Test Report",
      pages: [
        { id: "1", name: "intro" },
        { id: "2", name: "body" },
      ],
    });
  });

  it("leaves already-structured data unchanged", async () => {
    const { engine } = await createLLMEngineWithCompleteOutput({
      title: "Test Report",
      pages: [
        { id: "1", name: "intro" },
        { id: "2", name: "body" },
      ],
    });

    await engine.signal({ type: "RUN" });

    expect(engine.results.result).toEqual({
      title: "Test Report",
      pages: [
        { id: "1", name: "intro" },
        { id: "2", name: "body" },
      ],
    });
  });

  it("parses real LLM output with multi-line stringified pages array", async () => {
    // Actual payload shape from a failed notion-research session (e04ad55a)
    // where the LLM stringified the pages array with newlines, em-dashes,
    // and escaped quotes
    const stringifiedPages = JSON.stringify(
      [
        {
          page_id: "3221d872-3ea3-817b-a10d-fbeef5dd4700",
          title: "Acme Engineering \u2014 Agent Development Environment",
          body: "Engineering wants to adopt AI-assisted code review but needs to run it locally on their own machines, using their own codebase and internal engineering standards.",
        },
        {
          page_id: "3221d872-3ea3-8108-8b95-d7cece1d9b44",
          title: "Weekly Standup \u2014 2026-03-10",
          body: "Discussed timeline for cockpit redesign. Key decision: ship MVP with pipeline diagram only, defer filmstrip to next sprint.",
        },
      ],
      null,
      2,
    );

    const { engine } = await createLLMEngineWithCompleteOutput({ pages: stringifiedPages });

    await engine.signal({ type: "RUN" });

    const result = engine.results.result;
    const PageSchema = z.object({ page_id: z.string(), title: z.string(), body: z.string() });
    const [first, second] = z.tuple([PageSchema, PageSchema]).parse(result?.pages);
    expect(first.page_id).toBe("3221d872-3ea3-817b-a10d-fbeef5dd4700");
    expect(first.title).toContain("\u2014");
    expect(second.title).toContain("Weekly Standup");
  });

  it("does not crash on malformed JSON-like strings", async () => {
    // Plain string that doesn't look like JSON (no leading { or [) stays as-is
    const { engine } = await createLLMEngineWithCompleteOutput({
      title: "Test Report",
      notes: "just a regular string value",
    });

    await engine.signal({ type: "RUN" });

    expect(engine.results.result).toEqual({
      title: "Test Report",
      notes: "just a regular string value",
    });
  });
});
