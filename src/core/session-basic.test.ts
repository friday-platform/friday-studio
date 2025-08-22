/**
 * Basic session tests - simplified version to avoid hanging issues
 */
import { assertEquals, assertExists } from "@std/assert";
import { Session, WorkspaceSession } from "./session.ts";
import { WorkspaceSessionStatus } from "@atlas/core";
import { InMemoryStorageAdapter } from "@atlas/storage";

// Disable LLM validation for all tests
Deno.env.set("DENO_TESTING", "true");

Deno.test("Session - should create with basic properties", async () => {
  const mockSignal = {
    id: "test-signal",
    type: "test",
    data: { message: "test" },
    provider: { name: "test-provider" },
  };

  const mockCallback = {
    execute: () => {},
    validate: () => true,
    onSuccess: () => {},
    onError: () => {},
    onComplete: () => {},
  };

  const memoryAdapter = new InMemoryStorageAdapter();
  const session = new Session(
    "test-workspace",
    {
      triggers: [mockSignal],
      callback: mockCallback,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    memoryAdapter,
    false,
  );

  try {
    assertExists(session.id);
    assertEquals(session.signals.triggers.length, 1);
    assertEquals(session.signals.triggers[0].id, "test-signal");
    assertEquals(session.status, WorkspaceSessionStatus.PENDING);
    assertEquals(session.progress(), 0);
  } finally {
    // Properly complete the session
    if (
      session.status === WorkspaceSessionStatus.PENDING ||
      session.status === WorkspaceSessionStatus.EXECUTING
    ) {
      session.complete();
    }

    // Dispose of memory
    const memory = session.memory;
    if (memory && typeof memory.dispose === "function") {
      await memory.dispose();
    }
  }
});

Deno.test("WorkspaceSession - should create with single signal", async () => {
  const mockSignal = {
    id: "test-signal",
    type: "test",
    data: { message: "test" },
    provider: { name: "test-provider" },
  };

  const memoryAdapter = new InMemoryStorageAdapter();
  const workspaceSession = new WorkspaceSession(
    "test-workspace",
    mockSignal,
    undefined,
    undefined,
    undefined,
    undefined,
    memoryAdapter,
    false,
  );

  try {
    assertExists(workspaceSession.id);
    assertEquals(workspaceSession.signals.triggers.length, 1);
    assertEquals(workspaceSession.signals.triggers[0].id, "test-signal");
    assertEquals(workspaceSession.status, WorkspaceSessionStatus.PENDING);
  } finally {
    // Properly complete the session
    if (
      workspaceSession.status === WorkspaceSessionStatus.PENDING ||
      workspaceSession.status === WorkspaceSessionStatus.EXECUTING
    ) {
      workspaceSession.complete();
    }

    // Dispose of memory
    const memory = workspaceSession.memory;
    if (memory && typeof memory.dispose === "function") {
      await memory.dispose();
    }
  }
});
