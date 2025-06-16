#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Test envelope message system validation and functionality
 */

import { expect } from "@std/expect";
import {
  ATLAS_MESSAGE_TYPES,
  createWorkspaceProcessSignalMessage,
  createWorkspaceGetStatusMessage,
  createSessionInitializeMessage,
  validateEnvelope,
  isWorkspaceProcessSignalMessage,
  isWorkspaceGetStatusMessage,
  isSessionInitializeMessage,
  type MessageSource,
} from "../../src/core/utils/message-envelope.ts";

Deno.test("Envelope System - Message Creation and Validation", async () => {
  const source: MessageSource = {
    workerId: "test-worker",
    workerType: "workspace-supervisor",
    workspaceId: "test-workspace",
  };

  // Test workspace process signal message
  const processSignalPayload = {
    signal: {
      id: "test-signal",
      provider: { name: "Test Provider", type: "test" },
      payload: { message: "Hello agents!" },
      metadata: {},
    },
    payload: { message: "Hello agents!" },
    sessionId: "test-session",
    signalConfig: {},
    jobs: {},
  };

  const processSignalMessage = createWorkspaceProcessSignalMessage(
    processSignalPayload,
    source,
    {
      correlationId: crypto.randomUUID(),
      traceHeaders: { "trace-id": "123" },
    }
  );

  // Validate envelope structure
  expect(processSignalMessage.id).toBeDefined();
  expect(processSignalMessage.type).toBe(ATLAS_MESSAGE_TYPES.WORKSPACE.PROCESS_SIGNAL);
  expect(processSignalMessage.domain).toBe("workspace");
  expect(processSignalMessage.source.workerId).toBe("test-worker");
  expect(processSignalMessage.source.workerType).toBe("workspace-supervisor");
  expect(processSignalMessage.payload).toEqual(processSignalPayload);

  // Test envelope validation
  const validation = validateEnvelope(processSignalMessage);
  expect(validation.success).toBe(true);

  // Test type guards
  expect(isWorkspaceProcessSignalMessage(processSignalMessage)).toBe(true);
  expect(isWorkspaceGetStatusMessage(processSignalMessage)).toBe(false);

  console.log("✅ Workspace process signal message created and validated successfully");
});

Deno.test("Envelope System - Session Message Creation", () => {
  const source: MessageSource = {
    workerId: "workspace-supervisor",
    workerType: "workspace-supervisor",
    sessionId: "test-session",
    workspaceId: "test-workspace",
  };

  const sessionInitPayload = {
    intent: {
      id: "test-intent",
      constraints: {
        timeLimit: 300000,
        costLimit: 10.0,
      },
    },
    signal: { id: "test-signal", type: "webhook" },
    payload: { data: "test" },
    workspaceId: "test-workspace",
    agents: [
      {
        id: "test-agent",
        name: "Test Agent",
        purpose: "Testing",
        type: "llm" as const,
        config: { model: "test" },
      },
    ],
    jobSpec: {
      id: "test-job",
      name: "Test Job",
      description: "Test job description",
      execution: {
        strategy: "sequential" as const,
        agents: [{
          id: "test-agent",
          mode: "test",
          prompt: "test prompt",
          config: {},
          input: {},
        }],
      },
    },
    additionalPrompts: {
      session: "test session prompt",
    },
  };

  const sessionMessage = createSessionInitializeMessage(
    sessionInitPayload,
    source,
    {
      correlationId: crypto.randomUUID(),
    }
  );

  // Validate session message
  expect(sessionMessage.type).toBe(ATLAS_MESSAGE_TYPES.SESSION.INITIALIZE);
  expect(sessionMessage.domain).toBe("session");
  expect(isSessionInitializeMessage(sessionMessage)).toBe(true);

  const validation = validateEnvelope(sessionMessage);
  expect(validation.success).toBe(true);

  console.log("✅ Session initialize message created and validated successfully");
});

Deno.test("Envelope System - Domain Validation", () => {
  const source: MessageSource = {
    workerId: "test-worker",
    workerType: "workspace-supervisor",
  };

  // Create a workspace status message
  const statusPayload = {
    ready: true,
    workspaceId: "test-workspace",
    sessions: 2,
    activeSessions: [
      {
        sessionId: "session-1",
        status: "executing" as const,
        startTime: Date.now(),
        duration: 1000,
      },
    ],
  };

  const statusMessage = createWorkspaceGetStatusMessage(
    { workspaceId: "test-workspace" },
    source
  );

  // Validate domain-specific validation
  expect(statusMessage.domain).toBe("workspace");
  expect(isWorkspaceGetStatusMessage(statusMessage)).toBe(true);
  expect(isWorkspaceProcessSignalMessage(statusMessage)).toBe(false);
  expect(isSessionInitializeMessage(statusMessage)).toBe(false);

  console.log("✅ Domain validation working correctly");
});

Deno.test("Envelope System - Error Handling", () => {
  // Test invalid envelope validation
  const invalidEnvelope = {
    id: "not-a-uuid",
    type: "invalid-type",
    domain: "invalid-domain",
    source: {},
    payload: {},
  };

  const validation = validateEnvelope(invalidEnvelope);
  expect(validation.success).toBe(false);
  
  if (!validation.success) {
    expect(validation.error).toBeDefined();
    expect(validation.error.issues.length).toBeGreaterThan(0);
  }

  console.log("✅ Error handling and validation working correctly");
});