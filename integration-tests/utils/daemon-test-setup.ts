/**
 * Test utilities for daemon capabilities setup
 * Sets up mock daemon capabilities for integration testing
 */

import {
  createStreamsImplementation,
  DaemonCapabilityRegistry,
  type DaemonExecutionContext,
} from "../../src/core/daemon-capabilities.ts";

/**
 * Sets up daemon capabilities for testing
 * Returns a mock execution context for testing
 */
export function setupDaemonCapabilities(): DaemonExecutionContext {
  // Initialize daemon capability registry
  DaemonCapabilityRegistry.initialize();

  // Create a mock daemon instance for testing
  const mockDaemon = {
    // Mock daemon interface for testing
    version: "test-version",
    status: "running",

    // Mock methods that might be called during testing
    getStatus: () => ({ status: "running", version: "test-version" }),
    // Add other mock methods as needed
  };

  // Set the mock daemon instance
  DaemonCapabilityRegistry.setDaemonInstance(mockDaemon as any);

  // Return mock execution context
  const mockContext: DaemonExecutionContext = {
    sessionId: "test-session-123",
    agentId: "test-agent-456",
    workspaceId: "test-workspace-789",
    daemon: mockDaemon as any,
    conversationId: "test-conversation-abc",
    streams: createStreamsImplementation(),
  };

  return mockContext;
}

/**
 * Clean up daemon capabilities after testing
 */
export function cleanupDaemonCapabilities(): void {
  DaemonCapabilityRegistry.reset();
}
