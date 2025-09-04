import { AtlasDaemon } from "@atlas/atlasd";

/**
 * Minimal daemon harness for testing agents that require full platform integration.
 * Spins up real Atlas daemon with all services, following eval philosophy of testing
 * real behavior rather than mocks.
 */
export class DaemonTestHarness {
  private daemon: AtlasDaemon | null = null;
  private port: number;
  private serverPromise: Promise<{ finished: Promise<void> }> | null = null;

  constructor(port = 8080) {
    this.port = port;
  }

  /**
   * Start the daemon and wait for it to be ready.
   * Uses shorter timeout (10s) as daemon starts quickly in test environments.
   */
  async start(): Promise<string> {
    if (this.daemon) {
      throw new Error("Daemon already running");
    }

    this.daemon = new AtlasDaemon({
      port: this.port,
      maxConcurrentWorkspaces: 5,
      idleTimeoutMs: 60 * 1000, // 1 minute for tests
      sseHeartbeatIntervalMs: 10 * 1000, // 10 seconds for tests
    });

    // Start daemon non-blocking
    this.serverPromise = this.daemon.startNonBlocking();

    // Wait for daemon to be ready by polling health endpoint
    const baseUrl = `http://localhost:${this.port}`;
    const maxAttempts = 20; // 10 seconds total

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) {
          // Consume the response body to prevent leak
          await response.text();
          return baseUrl;
        }
        // If not ok, still consume the body
        await response.text();
      } catch {
        // Expected to fail initially
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error("Daemon failed to start within 10 seconds");
  }

  /**
   * Create a test session for agent execution.
   */
  createSession(): { sessionId: string; streamId: string; workspaceId: string; userId: string } {
    const sessionId = crypto.randomUUID();
    return {
      sessionId,
      streamId: `stream-${sessionId}`,
      workspaceId: "test-workspace",
      userId: "test-user",
    };
  }

  /**
   * Shutdown the daemon and cleanup.
   */
  async shutdown(): Promise<void> {
    if (!this.daemon) {
      return;
    }

    await this.daemon.shutdown();

    if (this.serverPromise) {
      const { finished } = await this.serverPromise;
      await finished;
    }

    this.daemon = null;
    this.serverPromise = null;
  }

  /**
   * Get the base URL for API calls.
   */
  getBaseUrl(): string {
    if (!this.daemon) {
      throw new Error("Daemon not started");
    }
    return `http://localhost:${this.port}`;
  }
}
