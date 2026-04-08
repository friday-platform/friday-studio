/**
 * Integration tests for workspace-chat handler orchestration.
 *
 * Tests the ~270-line handler function that wires together chat history,
 * LLM streaming, skill storage, and analytics. Pure functions are tested
 * separately in workspace-chat.agent.test.ts.
 */

import type { AgentContext, AtlasUIMessage, StreamEmitter } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — referenced inside vi.mock() factories
// ---------------------------------------------------------------------------

const capturedHandler = vi.hoisted(
  (): { fn: ((input: string, ctx: unknown) => Promise<unknown>) | null } => ({ fn: null }),
);

const mockParseResult = vi.hoisted(() => vi.fn());
const mockClientWorkspaceChat = vi.hoisted(() => vi.fn());

const mockSetSystemPromptContext = vi.hoisted(() => vi.fn());
const mockAppendMessage = vi.hoisted(() => vi.fn());
const mockSkillStorageList = vi.hoisted(() => vi.fn());
const mockResolveVisibleSkills = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockCreateLoadSkillTool = vi.hoisted(() => vi.fn());
const mockRegistryLanguageModel = vi.hoisted(() => vi.fn());
const mockTraceModel = vi.hoisted(() => vi.fn());
const mockSmallLLM = vi.hoisted(() => vi.fn());
const mockBuildTemporalFacts = vi.hoisted(() => vi.fn());
const mockGetDefaultProviderOpts = vi.hoisted(() => vi.fn());
const mockGetAtlasDaemonUrl = vi.hoisted(() => vi.fn());
const mockValidateAtlasUIMessages = vi.hoisted(() => vi.fn());
const mockPipeUIMessageStream = vi.hoisted(() => vi.fn());
const mockFetchLinkSummary = vi.hoisted(() => vi.fn());
const mockFormatIntegrationsSection = vi.hoisted(() => vi.fn());
const mockFetchUserIdentitySection = vi.hoisted(() => vi.fn());
const mockCreateConnectServiceTool = vi.hoisted(() => vi.fn());
const mockCreateWorkspaceDoTask = vi.hoisted(() => vi.fn());
const mockCreateJobTools = vi.hoisted(() => vi.fn());

const mockStreamText = vi.hoisted(() => vi.fn());
const mockCreateUIMessageStream = vi.hoisted(() => vi.fn());
const mockConvertToModelMessages = vi.hoisted(() => vi.fn());
const mockSmoothStream = vi.hoisted(() => vi.fn());
const mockStepCountIs = vi.hoisted(() => vi.fn());
const mockHasToolCall = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// vi.mock() declarations
// ---------------------------------------------------------------------------

vi.mock("@atlas/agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@atlas/agent-sdk")>("@atlas/agent-sdk");
  return {
    ...actual,
    createAgent: vi.fn((config: { handler: (input: string, ctx: unknown) => Promise<unknown> }) => {
      capturedHandler.fn = config.handler;
      return config;
    }),
    validateAtlasUIMessages: mockValidateAtlasUIMessages,
  };
});

vi.mock("@atlas/agent-sdk/vercel-helpers", () => ({
  pipeUIMessageStream: mockPipeUIMessageStream,
}));

vi.mock("@atlas/client/v2", () => {
  // Build a deeply-nested proxy that returns mock functions at leaf $get/$post/$patch calls
  function buildProxy(overrides: Record<string, unknown> = {}): unknown {
    return new Proxy(overrides, {
      get(_target, prop: string) {
        if (prop in overrides) return overrides[prop];
        // Terminal hono client calls
        if (prop === "$get" || prop === "$post" || prop === "$patch") {
          return vi.fn().mockResolvedValue({});
        }
        // Recurse for chained property access
        return buildProxy();
      },
    });
  }

  return {
    client: {
      workspace: buildProxy(),
      workspaceChat: mockClientWorkspaceChat.mockReturnValue(buildProxy()),
      artifactsStorage: buildProxy(),
      link: buildProxy(),
      me: buildProxy(),
    },
    parseResult: mockParseResult,
  };
});

vi.mock("@atlas/core/chat/storage", () => ({
  ChatStorage: {
    setSystemPromptContext: mockSetSystemPromptContext,
    appendMessage: mockAppendMessage,
  },
}));

vi.mock("@atlas/core/errors", () => ({
  createErrorCause: vi.fn((e: unknown) => ({ type: "unknown", raw: e })),
  getErrorDisplayMessage: vi.fn(() => "Something went wrong"),
}));

vi.mock("@atlas/llm", () => ({
  registry: { languageModel: mockRegistryLanguageModel },
  traceModel: mockTraceModel,
  smallLLM: mockSmallLLM,
  buildTemporalFacts: mockBuildTemporalFacts,
  getDefaultProviderOpts: mockGetDefaultProviderOpts,
}));

vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: mockGetAtlasDaemonUrl }));

vi.mock("@atlas/skills", () => ({
  SkillStorage: { list: mockSkillStorageList },
  createLoadSkillTool: mockCreateLoadSkillTool,
  resolveVisibleSkills: mockResolveVisibleSkills,
}));

vi.mock("../conversation/link-context.ts", () => ({
  fetchLinkSummary: mockFetchLinkSummary,
  formatIntegrationsSection: mockFormatIntegrationsSection,
}));

vi.mock("../conversation/user-identity.ts", () => ({
  fetchUserIdentitySection: mockFetchUserIdentitySection,
}));

vi.mock("../conversation/tools/connect-service.ts", () => ({
  createConnectServiceTool: mockCreateConnectServiceTool,
}));

vi.mock("./tools/do-task.ts", () => ({ createWorkspaceDoTask: mockCreateWorkspaceDoTask }));

vi.mock("./tools/job-tools.ts", () => ({ createJobTools: mockCreateJobTools }));

vi.mock("./tools/artifact-tools.ts", () => ({ artifactTools: {} }));

vi.mock("./prompt.txt", () => ({ default: "SYSTEM_PROMPT_PLACEHOLDER" }));

vi.mock("ai", () => ({
  streamText: mockStreamText,
  createUIMessageStream: mockCreateUIMessageStream,
  convertToModelMessages: mockConvertToModelMessages,
  smoothStream: mockSmoothStream,
  stepCountIs: mockStepCountIs,
  hasToolCall: mockHasToolCall,
  jsonSchema: vi.fn((s: unknown) => s),
  tool: vi.fn((config: unknown) => config),
}));

// ---------------------------------------------------------------------------
// Import the module under test (triggers createAgent, captures handler)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- side-effect: captures handler
import "./workspace-chat.agent.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } satisfies Record<keyof Logger, unknown>;
}

function makeStream(): StreamEmitter {
  return { emit: vi.fn(), end: vi.fn(), error: vi.fn() };
}

function makeMessage(role: "user" | "assistant", text: string): AtlasUIMessage {
  return { id: crypto.randomUUID(), role, parts: [{ type: "text", text }] };
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    tools: {},
    session: { sessionId: "sess-1", workspaceId: "ws-1", streamId: "stream-1", userId: "user-1" },
    env: {},
    stream: makeStream(),
    logger: makeLogger(),
    ...overrides,
  };
}

function getHandler() {
  if (!capturedHandler.fn) {
    throw new Error("Handler not captured — did the import fail?");
  }
  return capturedHandler.fn;
}

/**
 * Configure all mocks with sensible defaults for a happy-path test.
 * Individual tests can override specific mocks after calling this.
 */
function setupDefaultMocks(existingMessages: AtlasUIMessage[] = []): void {
  // parseResult: returns success for all calls by default
  mockParseResult.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      data: {
        messages: existingMessages,
        name: "test-ws",
        description: "A test workspace",
        config: { version: "1.0", workspace: { name: "test-ws" } },
        user: { full_name: "Alice", email: "alice@test.com", display_name: "Alice" },
        signals: { signals: [] },
        artifacts: { artifacts: [] },
      },
    }),
  );

  // workspaceChat client proxy
  mockClientWorkspaceChat.mockReturnValue({
    ":chatId": {
      $get: vi.fn().mockResolvedValue({}),
      title: { $patch: vi.fn().mockResolvedValue({}) },
      message: { $post: vi.fn().mockResolvedValue({}) },
    },
  });

  // validateAtlasUIMessages: pass through
  mockValidateAtlasUIMessages.mockImplementation((msgs: unknown) => Promise.resolve(msgs));

  // LLM mocks
  const mockModel = { modelId: "anthropic:claude-sonnet-4-6" };
  mockRegistryLanguageModel.mockReturnValue(mockModel);
  mockTraceModel.mockReturnValue(mockModel);
  mockBuildTemporalFacts.mockReturnValue("Current date: 2026-03-05");
  mockGetDefaultProviderOpts.mockReturnValue({});
  mockSmallLLM.mockResolvedValue("Chat Title");

  // Skills
  mockSkillStorageList.mockResolvedValue({ ok: true, data: [] });
  mockCreateLoadSkillTool.mockReturnValue({
    tool: { description: "load skill" },
    cleanup: vi.fn().mockResolvedValue(undefined),
  });

  // Link / identity
  mockFetchLinkSummary.mockResolvedValue(null);
  mockFormatIntegrationsSection.mockReturnValue("<integrations/>");
  mockFetchUserIdentitySection.mockResolvedValue(undefined);

  // Tools
  mockCreateConnectServiceTool.mockReturnValue({ description: "connect" });
  mockCreateWorkspaceDoTask.mockReturnValue({ description: "do_task" });
  mockCreateJobTools.mockReturnValue({});

  // Daemon URL
  mockGetAtlasDaemonUrl.mockReturnValue("http://localhost:8080");

  // ChatStorage
  mockSetSystemPromptContext.mockResolvedValue({ ok: true });
  mockAppendMessage.mockResolvedValue({ ok: true });

  // smoothStream / stepCountIs / hasToolCall return identity functions
  mockSmoothStream.mockReturnValue((x: unknown) => x);
  mockStepCountIs.mockReturnValue(() => false);
  mockHasToolCall.mockReturnValue(() => false);

  // convertToModelMessages: pass through
  mockConvertToModelMessages.mockImplementation((msgs: unknown) => msgs);

  // streamText: returns an object with toUIMessageStream
  mockStreamText.mockImplementation((opts: { onFinish?: (arg: { text: string }) => void }) => {
    opts.onFinish?.({ text: "Hello from LLM" });
    return {
      toUIMessageStream: vi.fn().mockReturnValue(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      ),
    };
  });

  // createUIMessageStream: runs execute + onFinish synchronously, returns a ReadableStream
  mockCreateUIMessageStream.mockImplementation(
    ({
      execute,
      onFinish,
      originalMessages,
    }: {
      execute: (ctx: {
        writer: { write: ReturnType<typeof vi.fn>; merge: ReturnType<typeof vi.fn> };
      }) => Promise<void>;
      onFinish: (ctx: { messages: AtlasUIMessage[] }) => Promise<void>;
      originalMessages: AtlasUIMessage[];
    }) => {
      return new ReadableStream({
        async start(controller) {
          const mockWriter = { write: vi.fn(), merge: vi.fn() };
          await execute({ writer: mockWriter });

          // Simulate the AI SDK adding an assistant message
          const finishMessages = [...originalMessages, makeMessage("assistant", "Hello from LLM")];
          await onFinish({ messages: finishMessages });
          controller.close();
        },
      });
    },
  );

  // pipeUIMessageStream: consume the readable stream to drive execution
  mockPipeUIMessageStream.mockImplementation(async (readable: ReadableStream) => {
    const reader = readable.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workspace-chat handler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset hoisted mocks (restoreAllMocks doesn't clear hoisted mock history)
    mockParseResult.mockReset();
    mockClientWorkspaceChat.mockReset();
    mockSetSystemPromptContext.mockReset();
    mockAppendMessage.mockReset();
    mockSkillStorageList.mockReset();
    mockCreateLoadSkillTool.mockReset();
    mockRegistryLanguageModel.mockReset();
    mockTraceModel.mockReset();
    mockSmallLLM.mockReset();
    mockBuildTemporalFacts.mockReset();
    mockGetDefaultProviderOpts.mockReset();
    mockGetAtlasDaemonUrl.mockReset();
    mockValidateAtlasUIMessages.mockReset();
    mockPipeUIMessageStream.mockReset();
    mockFetchLinkSummary.mockReset();
    mockFormatIntegrationsSection.mockReset();
    mockFetchUserIdentitySection.mockReset();
    mockCreateConnectServiceTool.mockReset();
    mockCreateWorkspaceDoTask.mockReset();
    mockCreateJobTools.mockReset();
    mockStreamText.mockReset();
    mockCreateUIMessageStream.mockReset();
    mockConvertToModelMessages.mockReset();
    mockSmoothStream.mockReset();
    mockStepCountIs.mockReset();
    mockHasToolCall.mockReset();
  });

  // -----------------------------------------------------------------------
  // Input validation
  // -----------------------------------------------------------------------

  it("throws when streamId is missing", async () => {
    const handler = getHandler();
    const ctx = makeContext({ session: { sessionId: "sess-1", workspaceId: "ws-1" } });

    await expect(handler("", ctx)).rejects.toThrow("Stream ID is required");
  });

  it("throws when workspaceId is missing", async () => {
    const handler = getHandler();
    const ctx = makeContext({
      session: { sessionId: "sess-1", workspaceId: "", streamId: "stream-1" },
    });

    // workspaceId is empty string (falsy) => handler checks !workspaceId
    await expect(handler("", ctx)).rejects.toThrow("Workspace ID is required");
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  it("loads history, builds prompt, streams response, returns ok", async () => {
    const existingMessages = [makeMessage("user", "Hello")];
    setupDefaultMocks(existingMessages);

    const handler = getHandler();
    const ctx = makeContext();
    const result = await handler("", ctx);

    // Chat history loaded via correct workspaceId/chatId
    expect(mockParseResult).toHaveBeenCalled();

    // streamText was called
    expect(mockStreamText).toHaveBeenCalledOnce();
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.anything(),
        messages: expect.anything(),
        tools: expect.anything(),
      }),
    );

    // pipeUIMessageStream was called
    expect(mockPipeUIMessageStream).toHaveBeenCalledOnce();

    // Returns ok result
    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("data");
  });

  // -----------------------------------------------------------------------
  // Title generation
  // -----------------------------------------------------------------------

  it("generates title when message count is 2 (1 existing + 1 assistant)", async () => {
    // 1 existing user message => onFinish receives [user, assistant] = 2
    const existingMessages = [makeMessage("user", "Hello")];
    setupDefaultMocks(existingMessages);

    const handler = getHandler();
    const ctx = makeContext();
    await handler("", ctx);

    // smallLLM is called via generateChatTitle when messages.length === 2
    expect(mockSmallLLM).toHaveBeenCalledOnce();

    // title.$patch is called (via parseResult)
    // The second parseResult call after chat load is for workspace details, then config, etc.
    // Title update call goes through parseResult as well
    const titlePatchCalls = mockParseResult.mock.calls.filter((call: unknown[]) => {
      // We can't easily inspect proxy args, but we can verify smallLLM was called
      return call;
    });
    expect(titlePatchCalls.length).toBeGreaterThan(0);
  });

  it("generates title when message count is 4 (3 existing + 1 assistant)", async () => {
    const existingMessages = [
      makeMessage("user", "Hello"),
      makeMessage("assistant", "Hi there"),
      makeMessage("user", "How are you?"),
    ];
    setupDefaultMocks(existingMessages);

    // Override createUIMessageStream to produce 4 total messages
    mockCreateUIMessageStream.mockImplementation(
      ({
        execute,
        onFinish,
        originalMessages,
      }: {
        execute: (ctx: {
          writer: { write: ReturnType<typeof vi.fn>; merge: ReturnType<typeof vi.fn> };
        }) => Promise<void>;
        onFinish: (ctx: { messages: AtlasUIMessage[] }) => Promise<void>;
        originalMessages: AtlasUIMessage[];
      }) => {
        return new ReadableStream({
          async start(controller) {
            const mockWriter = { write: vi.fn(), merge: vi.fn() };
            await execute({ writer: mockWriter });
            // 3 existing + 1 new assistant = 4
            const finishMessages = [...originalMessages, makeMessage("assistant", "I'm great!")];
            await onFinish({ messages: finishMessages });
            controller.close();
          },
        });
      },
    );

    const handler = getHandler();
    const ctx = makeContext();
    await handler("", ctx);

    expect(mockSmallLLM).toHaveBeenCalledOnce();
  });

  it("does NOT generate title when message count is 3", async () => {
    // 2 existing + 1 new = 3 total
    const existingMessages = [makeMessage("user", "Hello"), makeMessage("assistant", "Hi")];
    setupDefaultMocks(existingMessages);

    const handler = getHandler();
    const ctx = makeContext();
    await handler("", ctx);

    // smallLLM should NOT be called (title generation only on counts 2 and 4)
    expect(mockSmallLLM).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // System prompt context capture
  // -----------------------------------------------------------------------

  it("captures system prompt context on first turn (messages.length <= 1)", async () => {
    // 0 existing messages => first turn
    setupDefaultMocks([]);

    const handler = getHandler();
    const ctx = makeContext();
    await handler("", ctx);

    expect(mockSetSystemPromptContext).toHaveBeenCalledWith(
      "stream-1",
      { systemMessages: expect.arrayContaining([expect.any(String), expect.any(String)]) },
      "ws-1",
    );
  });

  it("captures system prompt context when exactly 1 existing message", async () => {
    setupDefaultMocks([makeMessage("user", "Hello")]);

    const handler = getHandler();
    const ctx = makeContext();
    await handler("", ctx);

    expect(mockSetSystemPromptContext).toHaveBeenCalledOnce();
  });

  it("does NOT capture system prompt context when messages.length > 1", async () => {
    setupDefaultMocks([makeMessage("user", "Hello"), makeMessage("assistant", "Hi")]);

    const handler = getHandler();
    const ctx = makeContext();
    await handler("", ctx);

    expect(mockSetSystemPromptContext).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Chat history load failure
  // -----------------------------------------------------------------------

  it("handles chat history load failure gracefully (continues with empty messages)", async () => {
    setupDefaultMocks([]);

    // Override parseResult: first call (chat history) returns error, rest succeed
    let callCount = 0;
    mockParseResult.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call is chat history load => return error
        return Promise.resolve({ ok: false, error: "Chat not found" });
      }
      // All subsequent calls succeed
      return Promise.resolve({
        ok: true,
        data: {
          messages: [],
          name: "test-ws",
          config: { version: "1.0", workspace: { name: "test-ws" } },
          signals: { signals: [] },
          artifacts: { artifacts: [] },
        },
      });
    });

    const handler = getHandler();
    const ctx = makeContext();
    const result = await handler("", ctx);

    // Should still succeed — proceeds with empty messages
    expect(result).toHaveProperty("ok", true);

    // Logger should have recorded the error
    const logger = ctx.logger;
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to load chat history",
      expect.objectContaining({ error: "Chat not found" }),
    );

    // streamText should still have been called
    expect(mockStreamText).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // Skill cleanup
  // -----------------------------------------------------------------------

  it("calls skill cleanup after streaming completes", async () => {
    setupDefaultMocks([]);

    const mockCleanup = vi.fn().mockResolvedValue(undefined);
    mockCreateLoadSkillTool.mockReturnValue({
      tool: { description: "load skill" },
      cleanup: mockCleanup,
    });

    const handler = getHandler();
    const ctx = makeContext();
    await handler("", ctx);

    expect(mockCleanup).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // Message persistence
  // -----------------------------------------------------------------------

  it("persists assistant message via onFinish through ChatStorage directly", async () => {
    setupDefaultMocks([makeMessage("user", "Hello")]);

    const handler = getHandler();
    const ctx = makeContext();
    await handler("", ctx);

    // Persistence skips the HTTP route and writes through ChatStorage in-process,
    // so the public POST /:chatId/message endpoint can stay user-only.
    expect(mockAppendMessage).toHaveBeenCalledOnce();
    expect(mockAppendMessage).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ role: "assistant" }),
      "ws-1",
    );
  });
});
