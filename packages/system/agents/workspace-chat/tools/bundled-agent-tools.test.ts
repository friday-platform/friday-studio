import type {
  AgentEnvironmentConfig,
  AgentSessionData,
  AtlasAgent,
  AtlasUIMessage,
  AtlasUIMessageChunk,
} from "@atlas/agent-sdk";
import { err, ok } from "@atlas/agent-sdk";
import type { PlatformModels } from "@atlas/agent-sdk/types";
import { CallbackStreamEmitter } from "@atlas/core/streaming";
import type { Logger } from "@atlas/logger";
import type { UIMessageStreamWriter } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { type CreateAgentToolDeps, createAgentTool } from "./bundled-agent-tools.ts";

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
  it("calls agent.execute with (input, context) and returns payload.data on ok", async () => {
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
    expect(input).toEqual({ prompt: "hi" });
    expect(context.stream).toBeInstanceOf(CallbackStreamEmitter);
    expect(context.session).toBe(deps.session);
    expect(context.platformModels).toBe(deps.platformModels);
    expect(context.env).toBe(deps.env);
  });

  it("bridges context.stream.emit to deps.writer.write with no transformation", async () => {
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
    expect(deps.writeFn).toHaveBeenCalledWith(event);
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
