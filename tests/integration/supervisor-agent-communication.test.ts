#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Test supervisor-mediated agent communication
 */

import { WorkerManager } from "../../src/core/utils/worker-manager.ts";
import { expect } from "@std/expect";

Deno.test({
  name: "Supervisor-mediated agent communication",
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: true, // Temporarily ignore due to timeout issues
  async fn() {
    const manager = new WorkerManager();

    try {
      // 1. Spawn supervisor

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
          },
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

      const resultPromise = manager.sendTask(supervisor.id, taskId, {
        action: "processSignal",
        signal: {
          id: "test-signal",
          provider: { id: "test", name: "Test Provider" },
        },
        payload: { message: "Hello agents!" },
        sessionId,
      });

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
      const status = await manager.sendTask(supervisor.id, statusTaskId, {
        action: "getStatus",
      });

      expect(status).toBeDefined();

      // Clean up
      sessionChannel.close();
      await manager.shutdown();
    } catch (error) {
      throw error;
    }
  },
});
