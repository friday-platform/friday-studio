import { client, parseResult } from "@atlas/client/v2";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { getContext, setContext } from "svelte";
import { DaemonClient } from "./daemon.ts";

const KEY = Symbol();

class ClientContext {
  daemonClient = new DaemonClient();

  private isSetupComplete = false;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 5000;

  daemonStatus = $state<"connected" | "error" | "idle">("idle");
  reconnectCountdown = $state<number>(0);
  conversationSessionId = $state<string | null>(null);

  getAtlasDaemonUrl() {
    return getAtlasDaemonUrl();
  }

  setup() {
    // If setup is already complete and daemon is connected, skip
    if (this.isSetupComplete && this.daemonStatus === "connected") {
      return;
    }

    // Clean up any existing connections but preserve session data
    this.cleanup();
  }

  async checkHealth() {
    // If manually triggered and in error state, show reconnecting status
    if (this.daemonStatus === "error" && this.reconnectCountdown > 0) {
      this.reconnectCountdown = 0;
    }

    try {
      // First check if daemon is healthy using the client directly
      const isDaemonHealthy = await parseResult(client.health.index.$get());

      if (isDaemonHealthy.ok) {
        const previousStatus = this.daemonStatus;
        this.daemonStatus = "connected";

        // If we're transitioning from error to connected, setup the conversation
        if (previousStatus === "error" || !this.isSetupComplete) {
          this.setup();
        }
      } else {
        this.daemonStatus = "error";
        this.isSetupComplete = false;

        // Ensure health checks continue to detect when daemon comes back
        if (this.healthCheckInterval === null) {
          this.startHealthCheckInterval();
        }
      }
    } catch {
      this.daemonStatus = "error";
      this.isSetupComplete = false;

      // Ensure health checks continue to detect when daemon comes back
      if (this.healthCheckInterval === null) {
        this.startHealthCheckInterval();
      }
    }
  }

  private cleanup() {
    // Stop health check interval only if requested
    this.stopHealthCheckInterval();
    this.stopCountdownInterval();
    this.reconnectCountdown = 0;
  }

  startHealthCheckInterval() {
    // Stop any existing intervals
    this.stopHealthCheckInterval();
    this.stopCountdownInterval();

    // Reset countdown
    this.reconnectCountdown = Math.floor(this.HEALTH_CHECK_INTERVAL_MS / 1000);

    // Start countdown timer (updates every second)
    this.countdownInterval = setInterval(() => {
      if (this.reconnectCountdown > 0) {
        this.reconnectCountdown--;
      }
    }, 1000);

    // Start periodic health checks
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth();
      // Reset countdown after each check
      if (this.daemonStatus === "error") {
        this.reconnectCountdown = Math.floor(this.HEALTH_CHECK_INTERVAL_MS / 1000);
      }
    }, this.HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheckInterval() {
    if (this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private stopCountdownInterval() {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  // Method to stop all monitoring when component is destroyed
  destroy() {
    this.cleanup();
  }
}

export function setClientContext() {
  const ctx = new ClientContext();
  return setContext(KEY, ctx);
}

export function getClientContext() {
  return getContext<ReturnType<typeof setClientContext>>(KEY);
}
