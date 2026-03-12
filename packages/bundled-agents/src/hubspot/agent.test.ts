import { env } from "node:process";
import type { AgentContext } from "@atlas/agent-sdk";
import type { LogContext, Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
