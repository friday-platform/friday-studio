/**
 * Regression test for runtime.ts:3027 — the direct tool.execute call inside
 * executeCodeAgent's mcpToolCall closure must thread opts.abortSignal through
 * to tools. Without that, any tool that opts into reading opts.abortSignal
 * (e.g. bash-tool after the tracer-bullet task) sees `undefined` even though
 * the composed signal is in scope on the surrounding executeCodeAgent call.
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import type { AgentResult } from "@atlas/agent-sdk";
import type { MergedConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import { makeTempDir } from "@atlas/utils/temp.server";
import type { Tool } from "ai";
import { tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mcpToolsHandles = vi.hoisted(() => ({
  tools: {} as Record<string, Tool>,
  dispose: vi.fn(async () => {}),
}));

vi.mock("@atlas/mcp", async (importActual) => {
  const actual = await importActual<typeof import("@atlas/mcp")>();
  return { ...actual, createMCPTools: vi.fn(() => Promise.resolve(mcpToolsHandles)) };
});

function emptyConfig(): MergedConfig {
  return {
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test-workspace", description: "Test workspace" },
    },
  };
}

describe("executeCodeAgent forwards opts.abortSignal into mcpToolCall tool.execute", () => {
  let testDir: string;
  let originalAtlasHome: string | undefined;

  beforeEach(() => {
    testDir = makeTempDir({ prefix: "atlas_code_agent_abort_test_" });
    originalAtlasHome = process.env.FRIDAY_HOME;
    process.env.FRIDAY_HOME = testDir;
  });

  afterEach(async () => {
    if (originalAtlasHome) process.env.FRIDAY_HOME = originalAtlasHome;
    else delete process.env.FRIDAY_HOME;
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("aborting the parent signal also aborts the signal seen by the stub tool", async () => {
    const { WorkspaceRuntime } = await import("./runtime.ts");

    const runtime = new WorkspaceRuntime({ id: "test-workspace-id" }, emptyConfig(), {
      workspacePath: testDir,
      lazy: true,
      platformModels: createStubPlatformModels(),
    });

    // Stub the user adapter so executeCodeAgent doesn't try to load a real
    // agent from disk. Returning a minimal AgentSourceData is enough — the
    // code path only reads `metadata.sourceLocation`, `metadata.entrypoint`,
    // `metadata.useWorkspaceSkills`, `metadata.mcp`, `metadata.llm`.
    const r = runtime as unknown as {
      userAdapter: {
        loadAgent: (
          id: string,
        ) => Promise<{
          type: "user";
          id: string;
          metadata: {
            sourceLocation: string;
            version: string;
            useWorkspaceSkills?: boolean;
            entrypoint?: string;
            mcp?: Record<string, never>;
            llm?: Record<string, never>;
          };
        }>;
      };
      executeCodeAgent: (
        userAgentId: string,
        prompt: string,
        opts: { sessionId: string; workspaceId: string; abortSignal?: AbortSignal },
      ) => Promise<AgentResult>;
    };
    r.userAdapter.loadAgent = (id: string) =>
      Promise.resolve({
        type: "user" as const,
        id,
        metadata: { sourceLocation: testDir, version: "0.0.0", useWorkspaceSkills: false },
      });

    // Capture the AbortSignal handed to the stub tool's execute().
    let capturedSignal: AbortSignal | undefined;
    mcpToolsHandles.tools = {
      "stub-tool": tool({
        description: "stub",
        inputSchema: z.object({}),
        execute: (_args, opts) => {
          capturedSignal = opts.abortSignal;
          return Promise.resolve({ ok: true });
        },
      }),
    };

    // Stub agentExecutor: pretend the agent decided to call our stub tool,
    // then return a successful AgentResult.
    runtime["options"].agentExecutor = {
      execute: async (_agentPath, _prompt, executorOpts) => {
        await executorOpts.mcpToolCall("stub-tool", {});
        return {
          agentId: "test-agent",
          timestamp: new Date().toISOString(),
          input: {},
          ok: true as const,
          data: "ok",
          durationMs: 0,
        };
      },
    };

    const parent = new AbortController();
    const promise = r.executeCodeAgent("test-agent", "do work", {
      sessionId: "test-session",
      workspaceId: "test-workspace-id",
      abortSignal: parent.signal,
    });

    await promise;
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
    parent.abort(new Error("client disconnected"));
    expect(capturedSignal?.aborted).toBe(true);

    await runtime.shutdown();
  });
});
