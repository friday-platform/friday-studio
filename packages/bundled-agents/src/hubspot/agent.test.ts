import { env } from "node:process";
import type { AgentContext } from "@atlas/agent-sdk";
import type { LogContext, Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createCommentFixture from "./fixtures/create-comment.json" with { type: "json" };

const { mockGenerateText } = vi.hoisted(() => ({ mockGenerateText: vi.fn() }));

vi.mock("ai", () => ({
  generateText: mockGenerateText,
  stepCountIs: vi.fn(() => vi.fn()),
  tool: vi.fn((opts: Record<string, unknown>) => opts),
}));

vi.mock("@atlas/llm", () => ({
  registry: { languageModel: vi.fn(() => "mock-model") },
  traceModel: vi.fn((m: unknown) => m),
}));

vi.mock("@atlas/agent-sdk/vercel-helpers", () => ({
  collectToolUsageFromSteps: vi.fn(() => ({ assembledToolCalls: [], assembledToolResults: [] })),
}));

// Import after mocks are set up
const { hubspotAgent } = await import("./agent.ts");

/** Creates a minimal mock Logger for testing. */
function createMockLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: (_context: LogContext) => logger,
  };
  return logger;
}

/** Creates a minimal mock AgentContext for testing. */
function createMockContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    tools: {},
    session: { sessionId: "test-session", workspaceId: "test-workspace" },
    env: {},
    stream: undefined,
    logger: createMockLogger(),
    ...overrides,
  };
}

const validContext = () => createMockContext({ env: { HUBSPOT_ACCESS_TOKEN: "tok" } });

describe("hubspotAgent handler guards", () => {
  let originalAnthropicKey: string | undefined;
  let originalLitellmKey: string | undefined;

  beforeEach(() => {
    originalAnthropicKey = env.ANTHROPIC_API_KEY;
    originalLitellmKey = env.LITELLM_API_KEY;
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    if (originalAnthropicKey !== undefined) {
      env.ANTHROPIC_API_KEY = originalAnthropicKey;
    } else {
      delete env.ANTHROPIC_API_KEY;
    }
    if (originalLitellmKey !== undefined) {
      env.LITELLM_API_KEY = originalLitellmKey;
    } else {
      delete env.LITELLM_API_KEY;
    }
  });

  it("fails fast without HUBSPOT_ACCESS_TOKEN", async () => {
    env.ANTHROPIC_API_KEY = "sk-test";
    const result = await hubspotAgent.execute("test", createMockContext({ env: {} }));

    expect(result.ok).toEqual(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("HUBSPOT_ACCESS_TOKEN");
    }
  });

  it("fails fast without LLM API key", async () => {
    delete env.ANTHROPIC_API_KEY;
    delete env.LITELLM_API_KEY;
    const result = await hubspotAgent.execute(
      "test",
      createMockContext({ env: { HUBSPOT_ACCESS_TOKEN: "token" } }),
    );

    expect(result.ok).toEqual(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("ANTHROPIC_API_KEY");
    }
  });
});

describe("hubspotAgent handler", () => {
  let originalAnthropicKey: string | undefined;

  beforeEach(() => {
    originalAnthropicKey = env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = "sk-test";
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    if (originalAnthropicKey !== undefined) {
      env.ANTHROPIC_API_KEY = originalAnthropicKey;
    } else {
      delete env.ANTHROPIC_API_KEY;
    }
  });

  it("returns ok with response text on success", async () => {
    mockGenerateText.mockResolvedValue({
      text: "Found 3 contacts at Acme Corp.",
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 50 },
      steps: [{}],
      toolCalls: [],
      toolResults: [],
    });

    const result = await hubspotAgent.execute("find contacts at Acme", validContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.response).toBe("Found 3 contacts at Acme Corp.");
    }
  });

  it("returns err when finishReason is error", async () => {
    mockGenerateText.mockResolvedValue({
      text: "",
      finishReason: "error",
      usage: {},
      steps: [],
      toolCalls: [],
      toolResults: [],
    });

    const result = await hubspotAgent.execute("test", validContext());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("Failed to process CRM request");
    }
  });

  it("returns err when step limit hit with no text", async () => {
    mockGenerateText.mockResolvedValue({
      text: "",
      finishReason: "stop",
      usage: {},
      steps: Array.from({ length: 20 }, () => ({})),
      toolCalls: [],
      toolResults: [],
    });

    const result = await hubspotAgent.execute("test", validContext());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("step limit");
    }
  });

  it("returns fallback text when LLM produces empty response", async () => {
    mockGenerateText.mockResolvedValue({
      text: "",
      finishReason: "stop",
      usage: {},
      steps: [{}],
      toolCalls: [],
      toolResults: [],
    });

    const result = await hubspotAgent.execute("test", validContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.response).toBe("CRM operation completed but no summary was generated.");
    }
  });

  it("returns err when generateText throws", async () => {
    mockGenerateText.mockRejectedValue(new Error("network timeout"));

    const result = await hubspotAgent.execute("test", validContext());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("network timeout");
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic path
// ---------------------------------------------------------------------------

/** Creates a mock fetch that returns the given body as JSON. */
function createMockFetch(body: unknown, status = 200) {
  return vi
    .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        statusText: status === 200 ? "OK" : "Bad Request",
        headers: { "Content-Type": "application/json" },
      }),
    );
}

describe("hubspotAgent deterministic path", () => {
  let originalAnthropicKey: string | undefined;

  beforeEach(() => {
    originalAnthropicKey = env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = "sk-test";
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalAnthropicKey !== undefined) {
      env.ANTHROPIC_API_KEY = originalAnthropicKey;
    } else {
      delete env.ANTHROPIC_API_KEY;
    }
  });

  it("executes send-thread-comment and returns structured output", async () => {
    vi.stubGlobal("fetch", createMockFetch(createCommentFixture));

    const prompt = JSON.stringify({
      operation: "send-thread-comment",
      threadId: "11306536687",
      text: "Hello from the deterministic path",
    });

    const result = await hubspotAgent.execute(prompt, validContext());

    expect(result.ok).toBe(true);
    expect.assert(result.ok);
    expect(result.data).toMatchObject({
      response: "Comment posted to thread 11306536687",
      operation: "send-thread-comment",
      success: true,
    });
    expect(result.data.data).toMatchObject({
      id: "c87bc7e6-d84f-455d-86cd-b271573760cd",
      threadId: "11306536687",
    });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("passes text through byte-for-byte without mutation", async () => {
    const mockFetch = createMockFetch(createCommentFixture);
    vi.stubGlobal("fetch", mockFetch);

    const verbatimText =
      "Line 1\nLine 2\n\n## Heading with **bold** & <html>\n" +
      "Special chars: \"quotes\" 'apostrophes' `backticks` — em-dash\n" +
      "Unicode: \u00e9\u00e8\u00ea \u2603 \uD83D\uDE00\n" +
      "Trailing whitespace   \n";

    const prompt = JSON.stringify({
      operation: "send-thread-comment",
      threadId: "99",
      text: verbatimText,
    });

    await hubspotAgent.execute(prompt, validContext());

    expect(mockFetch).toHaveBeenCalledOnce();
    const init = mockFetch.mock.calls[0]![1];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.text).toBe(verbatimText);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("falls through to LLM when operation JSON has missing required fields", async () => {
    mockGenerateText.mockResolvedValue({
      text: "LLM response",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
      steps: [{}],
      toolCalls: [],
      toolResults: [],
    });

    const prompt = JSON.stringify({
      operation: "send-thread-comment",
      // missing threadId and text — parseOperationConfig can't validate, falls through
    });

    const result = await hubspotAgent.execute(prompt, validContext());

    expect(result.ok).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("falls through to LLM for JSON without operation key", async () => {
    mockGenerateText.mockResolvedValue({
      text: "LLM response",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
      steps: [{}],
      toolCalls: [],
      toolResults: [],
    });

    const prompt = JSON.stringify({ foo: "bar", baz: 123 });
    const result = await hubspotAgent.execute(prompt, validContext());

    expect(result.ok).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("falls through to LLM for freeform text prompt", async () => {
    mockGenerateText.mockResolvedValue({
      text: "Found 5 contacts",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
      steps: [{}],
      toolCalls: [],
      toolResults: [],
    });

    const result = await hubspotAgent.execute("find contacts at Acme", validContext());

    expect(result.ok).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("falls through to LLM for unknown operation name", async () => {
    mockGenerateText.mockResolvedValue({
      text: "LLM response",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
      steps: [{}],
      toolCalls: [],
      toolResults: [],
    });

    const prompt = JSON.stringify({ operation: "delete-everything", threadId: "123" });

    const result = await hubspotAgent.execute(prompt, validContext());

    expect(result.ok).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("extracts operation from code-fenced JSON in a larger prompt", async () => {
    vi.stubGlobal("fetch", createMockFetch(createCommentFixture));

    const prompt = [
      "Post the knowledge base answer as a thread comment.",
      "",
      "## Context Facts",
      "- Current Date: Tuesday, March 31, 2026",
      "",
      "## Available Documents",
      "",
      "### Document: hubspot-operation (type: hubspot-operation)",
      "```json",
      JSON.stringify({
        operation: "send-thread-comment",
        threadId: "11306536687",
        text: "Hello from the deterministic path",
      }),
      "```",
    ].join("\n");

    const result = await hubspotAgent.execute(prompt, validContext());

    expect(result.ok).toBe(true);
    expect.assert(result.ok);
    expect(result.data.operation).toBe("send-thread-comment");
    expect(result.data.success).toBe(true);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns err when tool execute returns an error", async () => {
    const mockFetch = createMockFetch(
      { status: "error", message: "Thread not found", category: "OBJECT_NOT_FOUND" },
      404,
    );
    vi.stubGlobal("fetch", mockFetch);

    const prompt = JSON.stringify({
      operation: "send-thread-comment",
      threadId: "nonexistent",
      text: "test",
    });

    const result = await hubspotAgent.execute(prompt, validContext());

    expect(result.ok).toBe(false);
    expect.assert(!result.ok);
    expect(result.error.reason).toContain("send-thread-comment failed");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
