import { type AgentExecutionContext, AgentOrchestrator } from "@atlas/core";
import { createLogger } from "@atlas/logger";
import { assertEquals, assertExists } from "@std/assert";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";

Deno.test("Explicit StreamId Management", async (t) => {
  await t.step("should only stream when supervisor provides explicit streamId", async () => {
    const config = { agentsServerUrl: "http://localhost:8081/mcp", executionTimeout: 10000 };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    // No streamId = no streaming
    const onStreamEventNoStream = spy();
    const contextNoStream: AgentExecutionContext = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      onStreamEvent: onStreamEventNoStream,
    };

    // Mock agent that emits events
    const mockAgent = {
      metadata: { id: "agent", displayName: "Test Agent", expertise: { domains: ["testing"] } },
      execute: async (prompt: string, context: any) => {
        // Try to emit - should be using NoOpStreamEmitter
        context.stream.emit({ type: "text", content: "test" });
        return { result: "done" };
      },
    };
    orchestrator.registerWrappedAgent("agent", mockAgent);

    await orchestrator.executeAgent("agent", "task", contextNoStream);

    // Verify NoOpStreamEmitter used (no actual streaming)
    assertSpyCalls(onStreamEventNoStream, 0);

    // With streamId = streaming enabled
    const onStreamEventWithStream = spy();
    const contextWithStream: AgentExecutionContext = {
      sessionId: "session-2",
      workspaceId: "workspace-1",
      streamId: "explicit-stream-id",
      onStreamEvent: onStreamEventWithStream,
    };

    await orchestrator.executeAgent("agent", "task", contextWithStream);

    // Verify streaming occurred
    assertSpyCalls(onStreamEventWithStream, 1);
    assertSpyCall(onStreamEventWithStream, 0, { args: [{ type: "text", content: "test" }] });

    await orchestrator.shutdown();
  });

  await t.step("should respect explicit streamId over generated one", async () => {
    const config = { agentsServerUrl: "http://localhost:8081/mcp", executionTimeout: 10000 };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    const explicitStreamId = "user-provided-stream-123";
    const onStreamEvent = spy();
    const context: AgentExecutionContext = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      streamId: explicitStreamId, // Explicit streamId provided
      onStreamEvent,
    };

    // Mock MCP client
    let capturedToolCallArgs: any;
    // @ts-expect-error - mocking private method
    orchestrator["getOrCreateSessionClient"] = async (sessionId: string) => {
      return {
        client: {
          callTool: async (args: any) => {
            capturedToolCallArgs = args;
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ type: "completed", result: { success: true } }),
                },
              ],
            };
          },
        },
        transport: {},
        lastActivity: Date.now(),
      };
    };

    await orchestrator.executeAgent("mcp-agent", "task", context);

    // Verify explicit streamId was used, not generated
    assertExists(capturedToolCallArgs);
    assertEquals(capturedToolCallArgs.arguments._sessionContext.streamId, explicitStreamId);

    await orchestrator.shutdown();
  });

  await t.step("should handle wrapped agents without streamId correctly", async () => {
    const config = { agentsServerUrl: "http://localhost:8081/mcp", executionTimeout: 10000 };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    // Track which stream emitter type was used
    let streamEmitterType = "";
    const mockAgent = {
      metadata: { id: "agent", displayName: "Test Agent", expertise: { domains: ["testing"] } },
      execute: async (prompt: string, context: any) => {
        streamEmitterType = context.stream.constructor.name;
        return { result: "done" };
      },
    };
    orchestrator.registerWrappedAgent("agent", mockAgent);

    // Without streamId and without callback - should use NoOpStreamEmitter
    await orchestrator.executeAgent("agent", "task", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
    assertEquals(streamEmitterType, "NoOpStreamEmitter");

    // With callback but no streamId - should use NoOpStreamEmitter
    const onStreamEvent = spy();
    await orchestrator.executeAgent("agent", "task", {
      sessionId: "session-2",
      workspaceId: "workspace-1",
      onStreamEvent,
    });
    assertEquals(streamEmitterType, "NoOpStreamEmitter");

    // With both streamId and callback - should use CallbackStreamEmitter
    await orchestrator.executeAgent("agent", "task", {
      sessionId: "session-3",
      workspaceId: "workspace-1",
      streamId: "stream-123",
      onStreamEvent,
    });
    assertEquals(streamEmitterType, "CallbackStreamEmitter");

    await orchestrator.shutdown();
  });
});
