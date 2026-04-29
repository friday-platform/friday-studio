import type {
  AgentEnvironmentConfig,
  AgentSessionData,
  AtlasAgent,
  AtlasTool,
  AtlasUIMessage,
  AtlasUIMessageChunk,
} from "@atlas/agent-sdk";
import { err, ok } from "@atlas/agent-sdk";
import type { PlatformModels } from "@atlas/agent-sdk/types";
import { CallbackStreamEmitter } from "@atlas/core/streaming";
import type { Logger } from "@atlas/logger";
import type { UIMessageStreamWriter } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AGENT_TOOL_META,
  type CreateAgentToolDeps,
  createAgentTool,
  rebindAgentTool,
} from "./bundled-agent-tools.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeLogger = (): Logger =>
  ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }) as unknown as Logger;

const makeSession = (): AgentSessionData => ({ sessionId: "sess-1", workspaceId: "ws-1" });

const makePlatformModels = (): PlatformModels => ({ get: vi.fn() }) as unknown as PlatformModels;

interface MockAgentOptions {
  id?: string;
  description?: string;
  required?: AgentEnvironmentConfig["required"];
  inputSchema?: z.ZodSchema;
  execute?: AtlasAgent["execute"];
}

function makeAgent(opts: MockAgentOptions = {}): AtlasAgent {
  return {
    metadata: {
      id: opts.id ?? "test",
      version: "1.0.0",
      description: opts.description ?? "Test agent",
      expertise: { examples: [] },
      ...(opts.inputSchema ? { inputSchema: opts.inputSchema } : {}),
    },
    environmentConfig: opts.required ? { required: opts.required } : undefined,
    mcpConfig: undefined,
    llmConfig: undefined,
    useWorkspaceSkills: false,
    execute: opts.execute ?? vi.fn(() => Promise.resolve(ok({ response: "default" }))),
  };
}

interface MakeDepsOverrides {
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  writeFn?: ReturnType<typeof vi.fn>;
}

function makeDeps(
  overrides: MakeDepsOverrides = {},
): CreateAgentToolDeps & { writeFn: ReturnType<typeof vi.fn> } {
  const writeFn = overrides.writeFn ?? vi.fn();
  const writer = { write: writeFn } as unknown as UIMessageStreamWriter<AtlasUIMessage>;
  return {
    writer,
    session: makeSession(),
    platformModels: makePlatformModels(),
    abortSignal: overrides.abortSignal,
    env: overrides.env ?? {},
    logger: makeLogger(),
    writeFn,
  };
}

function getExecute(
  toolObj: unknown,
): (
  input: unknown,
  options: { toolCallId: string; messages: []; abortSignal: AbortSignal },
) => Promise<unknown> {
  if (
    typeof toolObj === "object" &&
    toolObj !== null &&
    "execute" in toolObj &&
    typeof (toolObj as { execute: unknown }).execute === "function"
  ) {
    return (toolObj as { execute: (input: unknown, options: unknown) => Promise<unknown> })
      .execute as never;
  }
  throw new Error("tool has no execute method");
}

const callOpts = {
  toolCallId: "tc-1",
  messages: [] as [],
  abortSignal: new AbortController().signal,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createAgentTool — registration", () => {
  it("returns { agent_<id>: tool } when env requirements are met", () => {
    const agent = makeAgent({
      id: "test",
      required: [{ name: "KEY", description: "required api key" }],
    });
    const deps = makeDeps({ env: { KEY: "value" } });

    const tools = createAgentTool(agent, deps);

    expect(tools).toHaveProperty("agent_test");
    expect(tools.agent_test).toBeDefined();
  });

  it("preserves dashes in agent IDs", () => {
    const agent = makeAgent({ id: "data-analyst" });
    const tools = createAgentTool(agent, makeDeps());
    expect(tools).toHaveProperty("agent_data-analyst");
  });

  it("uses agent.metadata.description as the tool description", () => {
    const agent = makeAgent({ id: "test", description: "does the thing" });
    const tools = createAgentTool(agent, makeDeps());
    const t = tools.agent_test;
    if (!t) throw new Error("tool missing");
    expect(t.description).toBe("does the thing");
  });
});

describe("createAgentTool — env gating", () => {
  it("returns {} and logs debug when a required env key is missing", () => {
    const agent = makeAgent({ id: "test", required: [{ name: "KEY", description: "required" }] });
    const deps = makeDeps({ env: {} });

    const tools = createAgentTool(agent, deps);

    expect(tools).toEqual({});
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("agent_test not registered"),
      expect.objectContaining({ missing: ["KEY"] }),
    );
  });

  it("returns {} when a required env key is present but empty", () => {
    const agent = makeAgent({ id: "test", required: [{ name: "KEY", description: "required" }] });
    const deps = makeDeps({ env: { KEY: "" } });

    expect(createAgentTool(agent, deps)).toEqual({});
  });

  it("registers the tool when no env keys are required", () => {
    const agent = makeAgent({ id: "test" });
    const tools = createAgentTool(agent, makeDeps());
    expect(tools).toHaveProperty("agent_test");
  });
});

describe("createAgentTool — execute (happy path)", () => {
  it("unwraps `input.prompt` for agents without an explicit object schema", async () => {
    const executeMock = vi.fn<AtlasAgent["execute"]>(() =>
      Promise.resolve(ok({ response: "hello" })),
    );
    const agent = makeAgent({ id: "test", execute: executeMock });
    const deps = makeDeps();

    const tools = createAgentTool(agent, deps);
    const result = await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);

    expect(result).toEqual({ response: "hello" });

    expect(executeMock).toHaveBeenCalledOnce();
    const call = executeMock.mock.calls[0];
    if (!call) throw new Error("executeMock was not called");
    const [input, context] = call;
    expect(input).toBe("hi");
    expect(context.stream).toBeInstanceOf(CallbackStreamEmitter);
    expect(context.session).toBe(deps.session);
    expect(context.platformModels).toBe(deps.platformModels);
    expect(context.env).toBe(deps.env);
  });

  it("passes the full `input` object for agents with an explicit object schema", async () => {
    const executeMock = vi.fn<AtlasAgent["execute"]>(() =>
      Promise.resolve(ok({ response: "hello" })),
    );
    const agent = makeAgent({
      id: "test",
      inputSchema: z.object({ query: z.string(), limit: z.number() }),
      execute: executeMock,
    });
    const deps = makeDeps();

    const tools = createAgentTool(agent, deps);
    const payload = { query: "hi", limit: 5 };
    const result = await getExecute(tools.agent_test)(payload, callOpts);

    expect(result).toEqual({ response: "hello" });

    expect(executeMock).toHaveBeenCalledOnce();
    const call = executeMock.mock.calls[0];
    if (!call) throw new Error("executeMock was not called");
    expect(call[0]).toEqual(payload);
  });

  it("wraps all emitted chunks in nested-chunk envelopes with the parent toolCallId", async () => {
    const event: AtlasUIMessageChunk = {
      type: "data-tool-progress",
      data: { toolName: "Test", content: "working..." },
    };

    const executeMock = vi.fn<AtlasAgent["execute"]>((_input, ctx) => {
      ctx.stream?.emit(event);
      return Promise.resolve(ok({ response: "done" }));
    });
    const agent = makeAgent({ id: "test", execute: executeMock });
    const deps = makeDeps();

    const tools = createAgentTool(agent, deps);
    await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);

    expect(deps.writeFn).toHaveBeenCalledOnce();
    expect(deps.writeFn).toHaveBeenCalledWith({
      type: "data-nested-chunk",
      data: { parentToolCallId: "tc-1", chunk: event },
    });
  });

  it("emits inner tool calls as nested-chunk envelopes with no mangled IDs", async () => {
    const innerChunk: AtlasUIMessageChunk = {
      type: "tool-input-available",
      toolCallId: "inner-fetch-1",
      toolName: "fetch",
      input: { url: "https://example.com" },
    };

    const executeMock = vi.fn<AtlasAgent["execute"]>((_input, ctx) => {
      ctx.stream?.emit(innerChunk);
      return Promise.resolve(ok({ response: "done" }));
    });
    const agent = makeAgent({ id: "test", execute: executeMock });
    const deps = makeDeps();

    const tools = createAgentTool(agent, deps);
    await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);

    expect(deps.writeFn).toHaveBeenCalledOnce();
    expect(deps.writeFn).toHaveBeenCalledWith({
      type: "data-nested-chunk",
      data: { parentToolCallId: "tc-1", chunk: innerChunk },
    });
  });

  it("produces nested-chunk envelopes for tool-input-start and tool-output-available with correct parentToolCallId", async () => {
    const startChunk: AtlasUIMessageChunk = {
      type: "tool-input-start",
      toolCallId: "child-1",
      toolName: "search",
    };
    const outputChunk: AtlasUIMessageChunk = {
      type: "tool-output-available",
      toolCallId: "child-1",
      output: { results: [] },
    };

    const executeMock = vi.fn<AtlasAgent["execute"]>((_input, ctx) => {
      ctx.stream?.emit(startChunk);
      ctx.stream?.emit(outputChunk);
      return Promise.resolve(ok({ response: "done" }));
    });
    const agent = makeAgent({ id: "test", execute: executeMock });
    const deps = makeDeps();

    const tools = createAgentTool(agent, deps);
    await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);

    expect(deps.writeFn).toHaveBeenCalledTimes(2);
    expect(deps.writeFn).toHaveBeenNthCalledWith(1, {
      type: "data-nested-chunk",
      data: { parentToolCallId: "tc-1", chunk: startChunk },
    });
    expect(deps.writeFn).toHaveBeenNthCalledWith(2, {
      type: "data-nested-chunk",
      data: { parentToolCallId: "tc-1", chunk: outputChunk },
    });
  });
});

describe("createAgentTool — execute (artifactRefs surfacing)", () => {
  const refs = [{ id: "art-1", type: "file", summary: "generated.png" }];

  it("merges payload.artifactRefs into the tool result when data is an object", async () => {
    const executeMock = vi.fn<AtlasAgent["execute"]>(() =>
      Promise.resolve(ok({ description: "an owl", mode: "generate" }, { artifactRefs: refs })),
    );
    const agent = makeAgent({ id: "test", execute: executeMock });
    const tools = createAgentTool(agent, makeDeps());

    const result = await getExecute(tools.agent_test)({ prompt: "draw an owl" }, callOpts);

    expect(result).toEqual({ description: "an owl", mode: "generate", artifacts: refs });
  });

  it("returns data unchanged when artifactRefs is absent", async () => {
    const executeMock = vi.fn<AtlasAgent["execute"]>(() =>
      Promise.resolve(ok({ response: "hello" })),
    );
    const agent = makeAgent({ id: "test", execute: executeMock });
    const tools = createAgentTool(agent, makeDeps());

    const result = await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);
    expect(result).toEqual({ response: "hello" });
    expect(result).not.toHaveProperty("artifacts");
  });

  it("returns data unchanged when artifactRefs is empty", async () => {
    const executeMock = vi.fn<AtlasAgent["execute"]>(() =>
      Promise.resolve(ok({ response: "hello" }, { artifactRefs: [] })),
    );
    const agent = makeAgent({ id: "test", execute: executeMock });
    const tools = createAgentTool(agent, makeDeps());

    const result = await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);
    expect(result).toEqual({ response: "hello" });
    expect(result).not.toHaveProperty("artifacts");
  });

  it("does not merge when data is not a plain object (string / array / null)", async () => {
    for (const data of ["raw string", [1, 2, 3], null] as const) {
      const executeMock = vi.fn<AtlasAgent["execute"]>(() =>
        Promise.resolve(ok(data as never, { artifactRefs: refs })),
      );
      const agent = makeAgent({ id: "test", execute: executeMock });
      const tools = createAgentTool(agent, makeDeps());

      const result = await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);
      expect(result).toEqual(data);
    }
  });
});

describe("createAgentTool — execute (error path)", () => {
  it("throws Error with payload.error.reason on err", async () => {
    const executeMock = vi.fn<AtlasAgent["execute"]>(() => Promise.resolve(err("boom")));
    const agent = makeAgent({ id: "test", execute: executeMock });
    const deps = makeDeps();

    const tools = createAgentTool(agent, deps);
    await expect(getExecute(tools.agent_test)({ prompt: "hi" }, callOpts)).rejects.toThrow("boom");
  });
});

describe("createAgentTool — abort propagation", () => {
  it("propagates parent AbortSignal through context.abortSignal", async () => {
    const controller = new AbortController();
    const executeMock = vi.fn<AtlasAgent["execute"]>((_input, ctx) => {
      controller.abort();
      // Capture state after abort fires — same ref, so .aborted flips to true
      expect(ctx.abortSignal?.aborted).toBe(true);
      return Promise.resolve(ok({ response: "done" }));
    });
    const agent = makeAgent({ id: "test", execute: executeMock });
    const deps = makeDeps({ abortSignal: controller.signal });

    const tools = createAgentTool(agent, deps);
    await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);

    expect(executeMock).toHaveBeenCalledOnce();
    const call = executeMock.mock.calls[0];
    if (!call) throw new Error("executeMock was not called");
    expect(call[1].abortSignal).toBe(controller.signal);
  });
});

describe("createAgentTool — metadata & rebind", () => {
  it("stores AGENT_TOOL_META on the tool object", () => {
    const agent = makeAgent({ id: "test" });
    const deps = makeDeps();

    const tools = createAgentTool(agent, deps);
    const t = tools.agent_test;
    if (!t) throw new Error("tool missing");

    const meta = (t as Record<symbol, unknown>)[AGENT_TOOL_META];
    expect(meta).toBeDefined();
    expect((meta as { atlasAgent: AtlasAgent }).atlasAgent).toBe(agent);
    expect((meta as { toolName: string }).toolName).toBe("agent_test");
  });

  it("rebindAgentTool returns original tool when meta is absent", () => {
    const fakeTool = { type: "tool", description: "fake" } as unknown as AtlasTool;
    const newWriter = { write: vi.fn() } as unknown as UIMessageStreamWriter<AtlasUIMessage>;

    const result = rebindAgentTool(fakeTool, newWriter);
    expect(result).toBe(fakeTool);
  });

  it("rebindAgentTool routes nested-chunk envelopes to the new writer", async () => {
    const executeMock = vi.fn<AtlasAgent["execute"]>((_input, ctx) => {
      ctx.stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Test", content: "rebound!" },
      });
      return Promise.resolve(ok({ response: "done" }));
    });
    const agent = makeAgent({ id: "test", execute: executeMock });
    const originalDeps = makeDeps();

    const tools = createAgentTool(agent, originalDeps);
    const newWriteFn = vi.fn();
    const newWriter = { write: newWriteFn } as unknown as UIMessageStreamWriter<AtlasUIMessage>;

    const rebound = rebindAgentTool(tools.agent_test!, newWriter);
    await getExecute(rebound)({ prompt: "hi" }, callOpts);

    expect(originalDeps.writeFn).not.toHaveBeenCalled();
    expect(newWriteFn).toHaveBeenCalledOnce();
    expect(newWriteFn).toHaveBeenCalledWith({
      type: "data-nested-chunk",
      data: {
        parentToolCallId: "tc-1",
        chunk: { type: "data-tool-progress", data: { toolName: "Test", content: "rebound!" } },
      },
    });
  });

  it("rebindAgentTool preserves original inner tool-call IDs in nested-chunk envelopes", async () => {
    const innerChunk: AtlasUIMessageChunk = {
      type: "tool-output-available",
      toolCallId: "inner-1",
      output: { ok: true },
    };

    const executeMock = vi.fn<AtlasAgent["execute"]>((_input, ctx) => {
      ctx.stream?.emit(innerChunk);
      return Promise.resolve(ok({ response: "done" }));
    });
    const agent = makeAgent({ id: "test", execute: executeMock });
    const originalDeps = makeDeps();

    const tools = createAgentTool(agent, originalDeps);
    const newWriteFn = vi.fn();
    const newWriter = { write: newWriteFn } as unknown as UIMessageStreamWriter<AtlasUIMessage>;

    const rebound = rebindAgentTool(tools.agent_test!, newWriter);
    await getExecute(rebound)({ prompt: "hi" }, callOpts);

    expect(newWriteFn).toHaveBeenCalledOnce();
    expect(newWriteFn).toHaveBeenCalledWith({
      type: "data-nested-chunk",
      data: { parentToolCallId: "tc-1", chunk: innerChunk },
    });
  });

  it("emits reasoning from AgentExtras as a nested-chunk data-tool-progress event after execute completes", async () => {
    const executeMock = vi.fn<AtlasAgent["execute"]>(() =>
      Promise.resolve(ok({ response: "done" }, { reasoning: "I thought about it" })),
    );
    const agent = makeAgent({ id: "test", execute: executeMock });
    const deps = makeDeps();

    const tools = createAgentTool(agent, deps);
    await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);

    const progressEvent = deps.writeFn.mock.calls.find(
      (call) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "type" in call[0] &&
        call[0].type === "data-nested-chunk",
    )?.[0];
    expect(progressEvent).toEqual({
      type: "data-nested-chunk",
      data: {
        parentToolCallId: "tc-1",
        chunk: {
          type: "data-tool-progress",
          data: { toolName: "test", content: "I thought about it" },
        },
      },
    });
  });

  it("does not emit post-hoc data-inner-tool-call events", async () => {
    const executeMock = vi.fn<AtlasAgent["execute"]>(() =>
      Promise.resolve(
        ok(
          { response: "done" },
          {
            toolCalls: [
              { type: "tool-call", toolCallId: "tc-1", toolName: "fetch", input: { url: "x" } },
            ],
            toolResults: [
              {
                type: "tool-result",
                toolCallId: "tc-1",
                toolName: "fetch",
                input: { url: "x" },
                output: "y",
              },
            ],
          },
        ),
      ),
    );
    const agent = makeAgent({ id: "test", execute: executeMock });
    const deps = makeDeps();

    const tools = createAgentTool(agent, deps);
    await getExecute(tools.agent_test)({ prompt: "hi" }, callOpts);

    const innerCallEvent = deps.writeFn.mock.calls.find(
      (call) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "type" in call[0] &&
        call[0].type === "data-inner-tool-call",
    )?.[0];
    expect(innerCallEvent).toBeUndefined();
  });
});
