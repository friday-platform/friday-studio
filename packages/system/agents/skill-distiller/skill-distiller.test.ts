import type { AgentContext } from "@atlas/agent-sdk";
import { createStubPlatformModels } from "@atlas/llm";
import type { LogContext, Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateObject = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, generateObject: mockGenerateObject };
});

import { skillDistillerAgent } from "./skill-distiller.agent.ts";

// =============================================================================
// Test Fixtures
// =============================================================================

const validCorpusArtifacts = {
  artifacts: [
    {
      id: "artifact-1",
      type: "summary" as const,
      revision: 1,
      title: "Coding Guidelines",
      summary: "Best practices for code",
      createdAt: "2024-01-01T00:00:00Z",
      data: {
        type: "summary" as const,
        version: 1 as const,
        data: "Always use TypeScript strict mode. Prefer composition over inheritance.",
      },
    },
    {
      id: "artifact-2",
      type: "summary" as const,
      revision: 1,
      title: "Review Notes",
      summary: "Code review feedback",
      createdAt: "2024-01-01T00:00:00Z",
      data: {
        type: "summary" as const,
        version: 1 as const,
        data: "Ensure all functions have proper error handling. Use Zod for validation.",
      },
    },
  ],
};

const existingDraftArtifact = {
  artifact: {
    id: "draft-123",
    type: "skill-draft" as const,
    revision: 1,
    title: "Skill: code-review",
    summary: "Code review guidelines",
    createdAt: "2024-01-01T00:00:00Z",
    workspaceId: "ws-123",
    data: {
      type: "skill-draft" as const,
      version: 1 as const,
      data: {
        name: "code-review",
        namespace: "my-team",
        description: "Guidelines for code review",
        instructions: "# Code Review\n\nCheck for errors.",
      },
    },
  },
};

// =============================================================================
// Mock Helpers
// =============================================================================

let originalFetch: typeof fetch;

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

const stubPlatformModels = createStubPlatformModels();

function createMockContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    tools: {},
    session: {
      sessionId: "test-session-id",
      workspaceId: "test-workspace-id",
      streamId: "test-stream-id",
    },
    env: { ANTHROPIC_API_KEY: "test-api-key" },
    stream: undefined,
    logger: createMockLogger(),
    platformModels: stubPlatformModels,
    ...overrides,
  };
}

interface FetchMockConfig {
  batchGetArtifacts?: { status: number; data?: unknown; error?: string };
}

function setupFetchMock(config: FetchMockConfig): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method?.toUpperCase() ?? "GET";

    // Match batch-get endpoint
    if (url.includes("/api/artifacts/batch") && method === "POST") {
      const response = config.batchGetArtifacts;
      if (!response) {
        return Promise.reject(new Error(`Unexpected batch-get call: ${url}`));
      }
      if (response.status === 200) {
        return Promise.resolve(
          new Response(JSON.stringify(response.data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: response.error }), {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected fetch URL: ${url} (method: ${method})`));
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("skillDistillerAgent", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockGenerateObject.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("returns error if artifacts not found", () => {
    it("returns error when batch-get returns empty array", async () => {
      setupFetchMock({ batchGetArtifacts: { status: 200, data: { artifacts: [] } } });

      const result = await skillDistillerAgent.execute(
        { artifactIds: ["nonexistent-1", "nonexistent-2"], namespace: "my-team" },
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toContain("No artifacts found");
      }
    });

    it("returns error when batch-get fails", async () => {
      setupFetchMock({ batchGetArtifacts: { status: 500, error: "Internal server error" } });

      const result = await skillDistillerAgent.execute(
        { artifactIds: ["artifact-1"], namespace: "my-team" },
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toContain("Failed to load corpus artifacts");
      }
    });

    it("returns error when batch-get returns 404", async () => {
      setupFetchMock({ batchGetArtifacts: { status: 404, error: "Not found" } });

      const result = await skillDistillerAgent.execute(
        { artifactIds: ["artifact-1"], namespace: "my-team" },
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toContain("Failed to load corpus artifacts");
      }
    });
  });

  describe("handles revision of existing draft", () => {
    it("loads existing draft when draftArtifactId is provided", async () => {
      // Track which endpoints were called
      const callLog: string[] = [];

      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method?.toUpperCase() ?? "GET";

        // Match batch-get endpoint
        if (url.includes("/api/artifacts/batch") && method === "POST") {
          callLog.push("batch-get");
          return Promise.resolve(
            new Response(JSON.stringify(validCorpusArtifacts), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        // Match single artifact GET endpoint for draft
        if (url.includes("/api/artifacts/draft-123") && method === "GET") {
          callLog.push("get-draft");
          return Promise.resolve(
            new Response(JSON.stringify(existingDraftArtifact), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        // Match artifact update endpoint
        if (url.includes("/api/artifacts/draft-123") && method === "PUT") {
          callLog.push("update-draft");
          return Promise.resolve(
            new Response(JSON.stringify(existingDraftArtifact), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        // Other calls - return error to fail fast
        return Promise.reject(new Error(`Unexpected fetch URL: ${url} (method: ${method})`));
      };

      await skillDistillerAgent.execute(
        {
          artifactIds: ["artifact-1", "artifact-2"],
          namespace: "my-team",
          draftArtifactId: "draft-123",
        },
        createMockContext(),
      );

      // Verify the correct endpoints were called
      expect(callLog).toContain("batch-get");
      expect(callLog).toContain("get-draft");
    });

    it("continues with new draft if existing draft fetch fails", async () => {
      const callLog: string[] = [];

      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method?.toUpperCase() ?? "GET";

        if (url.includes("/api/artifacts/batch") && method === "POST") {
          callLog.push("batch-get");
          return Promise.resolve(
            new Response(JSON.stringify(validCorpusArtifacts), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        // Draft fetch fails
        if (url.includes("/api/artifacts/draft-123") && method === "GET") {
          callLog.push("get-draft-failed");
          return Promise.resolve(
            new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch URL: ${url} (method: ${method})`));
      };

      await skillDistillerAgent.execute(
        { artifactIds: ["artifact-1"], namespace: "my-team", draftArtifactId: "draft-123" },
        createMockContext(),
      );

      // Verify draft fetch was attempted
      expect(callLog).toContain("get-draft-failed");
    });
  });

  describe("returns error if corpus is empty", () => {
    it("fails when artifactIds array is empty after validation", async () => {
      setupFetchMock({ batchGetArtifacts: { status: 200, data: { artifacts: [] } } });

      const result = await skillDistillerAgent.execute(
        {
          artifactIds: ["id-1"], // Pass validation but get empty response
          namespace: "my-team",
        },
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toContain("No artifacts found");
      }
    });
  });
});
