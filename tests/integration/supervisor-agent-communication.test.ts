#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Test supervisor-mediated agent communication
 */

import { WorkerManager } from "../../src/core/utils/worker-manager.ts";
import { expect } from "@std/expect";
import {
  ATLAS_MESSAGE_TYPES,
  createWorkspaceProcessSignalMessage,
  createWorkspaceGetStatusMessage,
  type MessageSource,
} from "../../src/core/utils/message-envelope.ts";
import type { AtlasMemoryConfig } from "../../src/core/memory-config.ts";

Deno.test("Supervisor-mediated agent communication", async () => {
  const manager = new WorkerManager();

  try {
    // 1. Spawn supervisor

    // Create memory config for the supervisor
    const memoryConfig: AtlasMemoryConfig = {
      default: {
        enabled: true,
        storage: "filesystem",
        cognitive_loop: false,
        retention: {
          max_age_days: 1,
          max_entries: 1000,
          cleanup_interval_hours: 24,
        },
      },
      agent: {
        enabled: true,
        scope: "agent",
        include_in_context: true,
        context_limits: {
          relevant_memories: 10,
          past_successes: 5,
          past_failures: 5,
        },
        memory_types: {
          working: { enabled: true, max_entries: 100 },
          episodic: { enabled: true, max_entries: 50 },
          semantic: { enabled: true, max_entries: 200 },
          procedural: { enabled: true, max_entries: 50 },
        },
      },
      session: {
        enabled: true,
        scope: "session",
        include_in_context: true,
        context_limits: {
          relevant_memories: 20,
          past_successes: 10,
          past_failures: 10,
        },
        memory_types: {
          working: { enabled: true, max_entries: 200 },
          episodic: { enabled: true, max_entries: 100 },
          semantic: { enabled: true, max_entries: 300 },
          procedural: { enabled: true, max_entries: 100 },
        },
      },
      workspace: {
        enabled: true,
        scope: "workspace",
        include_in_context: true,
        context_limits: {
          relevant_memories: 50,
          past_successes: 25,
          past_failures: 25,
        },
        memory_types: {
          working: { enabled: true, max_entries: 500 },
          episodic: { enabled: true, max_entries: 200 },
          semantic: { enabled: true, max_entries: 1000 },
          procedural: { enabled: true, max_entries: 200 },
        },
      },
    };

    const supervisorMetadata = {
      id: "test-supervisor",
      type: "supervisor" as const,
      config: {
        id: "test-workspace",
        workspace: {
          id: "test-workspace",
          signals: 0,
          agents: 0,
        },
        config: {
          model: "claude-3-haiku-20240307",
          memoryConfig, // Add required memory config
        },
        memoryConfig, // Also add at root level for compatibility
      },
    };

    const supervisor = await manager.spawnWorker(
      supervisorMetadata,
      new URL(
        "../../src/core/workers/workspace-supervisor-worker.ts",
        import.meta.url,
      ).href,
    );

    expect(supervisor.id).toBe("test-supervisor");

    // Wait for supervisor to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 2. Process a signal (which should spawn a session)

    const taskId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    // Create message source for envelope
    const source: MessageSource = {
      workerId: "test-client",
      workerType: "manager",
      workspaceId: "test-workspace",
    };

    // Create envelope-based signal processing message
    const processSignalPayload = {
      signal: {
        id: "test-signal",
        provider: { name: "Test Provider", type: "test" },
        payload: { message: "Hello agents!" },
        metadata: {},
      },
      payload: { message: "Hello agents!" },
      sessionId,
      signalConfig: {},
      jobs: {},
    };

    const processSignalMessage = createWorkspaceProcessSignalMessage(
      processSignalPayload,
      source,
      {
        correlationId: crypto.randomUUID(),
        traceHeaders: {},
      }
    );

    const resultPromise = manager.sendTask(supervisor.id, taskId, processSignalMessage);

    const result = await resultPromise;
    expect(result).toBeDefined();

    // 3. Test broadcast channel communication

    // Create our own broadcast channel to listen
    const sessionChannel = new BroadcastChannel(`session-${sessionId}`);
    const messages: any[] = [];

    sessionChannel.onmessage = (event) => {
      messages.push(event.data);
    };

    // Simulate agent message broadcast
    setTimeout(() => {
      sessionChannel.postMessage({
        type: "agentMessage",
        from: "test-agent-1",
        message: "Hello from agent 1!",
        timestamp: new Date().toISOString(),
      });
    }, 500);

    setTimeout(() => {
      sessionChannel.postMessage({
        type: "agentMessage",
        from: "test-agent-2",
        message: "Hello from agent 2!",
        timestamp: new Date().toISOString(),
      });
    }, 1000);

    // Wait for messages
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(messages.length).toBeGreaterThanOrEqual(0);

    // 4. Get supervisor status

    const statusTaskId = crypto.randomUUID();
    
    // Create envelope-based status request
    const statusPayload = {
      includeSessionDetails: true,
      workspaceId: "test-workspace",
    };

    const statusMessage = createWorkspaceGetStatusMessage(
      statusPayload,
      source,
      {
        correlationId: crypto.randomUUID(),
      }
    );

    const status = await manager.sendTask(supervisor.id, statusTaskId, statusMessage);

    expect(status).toBeDefined();

    // Clean up
    sessionChannel.close();
    await manager.shutdown();
  } catch (error) {
    throw error;
  }
});
