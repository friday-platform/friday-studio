/**
 * Atlas Daemon Metrics
 *
 * OTEL metrics instrumentation for atlasd. Metrics are exported via OTEL Collector
 * which exposes a Prometheus endpoint for GCP Managed Prometheus scraping.
 *
 * Requires OTEL_DENO=true environment variable to be set.
 */

import { env } from "node:process";
import type { WorkspaceSessionStatusType } from "@atlas/core";
import { logger } from "@atlas/logger";
import type { Counter, Meter } from "@opentelemetry/api";

// Lazy-loaded meter and metrics
let meter: Meter | null = null;
let isEnabled = false;
let initPromise: Promise<void> | null = null;

// Metrics instances (counters only - gauges are created inline with callbacks)
let sessionsCounter: Counter | null = null;
let signalTriggersCounter: Counter | null = null;
let mcpToolCallsCounter: Counter | null = null;

// Callback storage for observable gauges
let activeWorkspacesCallback: (() => number) | null = null;
let sseConnectionsCallback: (() => number) | null = null;
let uptimeCallback: (() => number) | null = null;

/**
 * Initialize OTEL metrics (async to handle dynamic imports).
 */
function initialize(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      // Check if OpenTelemetry should be enabled
      if (env.OTEL_DENO !== "true") {
        logger.debug("OTEL metrics disabled - set OTEL_DENO=true to enable");
        return;
      }

      // Dynamic import to avoid worker issues
      const { metrics } = await import("@opentelemetry/api");
      meter = metrics.getMeter("atlasd", "1.0.0");

      // Create observable gauges with inline callbacks
      meter
        .createObservableGauge("atlasd_active_workspaces", {
          description: "Currently loaded workspace runtimes",
          unit: "{workspaces}",
        })
        .addCallback((result) => {
          if (activeWorkspacesCallback) result.observe(activeWorkspacesCallback());
        });

      meter
        .createObservableGauge("atlasd_sse_connections", {
          description: "Active SSE client connections",
          unit: "{connections}",
        })
        .addCallback((result) => {
          if (sseConnectionsCallback) result.observe(sseConnectionsCallback());
        });

      meter
        .createObservableGauge("atlasd_uptime_seconds", {
          description: "Daemon uptime in seconds",
          unit: "s",
        })
        .addCallback((result) => {
          if (uptimeCallback) result.observe(uptimeCallback());
        });

      // Create counters
      sessionsCounter = meter.createCounter("atlasd_sessions_total", {
        description: "Session executions by status",
        unit: "{sessions}",
      });

      signalTriggersCounter = meter.createCounter("atlasd_signal_triggers_total", {
        description: "Signal trigger counts",
        unit: "{signals}",
      });

      mcpToolCallsCounter = meter.createCounter("atlasd_mcp_tool_calls_total", {
        description: "MCP tool invocations",
        unit: "{calls}",
      });

      isEnabled = true;
      logger.info("OTEL metrics enabled for atlasd", {
        serviceName: env.OTEL_SERVICE_NAME || "atlas",
      });
    } catch (error) {
      logger.warn("Failed to initialize OTEL metrics", { error: String(error) });
      isEnabled = false;
    }
  })();

  return initPromise;
}

/**
 * AtlasMetrics - OTEL metrics instrumentation for atlasd.
 */
export const AtlasMetrics = {
  /**
   * Check if metrics are enabled.
   */
  get enabled(): boolean {
    return isEnabled;
  },

  /**
   * Initialize metrics (call once at daemon startup).
   */
  async init(): Promise<void> {
    await initialize();
  },

  /**
   * Register callback to provide active workspaces count.
   */
  registerActiveWorkspacesProvider(callback: () => number): void {
    activeWorkspacesCallback = callback;
  },

  /**
   * Register callback to provide SSE connections count.
   */
  registerSSEConnectionsProvider(callback: () => number): void {
    sseConnectionsCallback = callback;
  },

  /**
   * Register callback to provide uptime in seconds.
   */
  registerUptimeProvider(callback: () => number): void {
    uptimeCallback = callback;
  },

  /**
   * Record a session execution.
   */
  recordSession(status: WorkspaceSessionStatusType): void {
    if (!isEnabled || !sessionsCounter) return;
    sessionsCounter.add(1, { status });
  },

  /**
   * Record a signal trigger.
   * @param provider - Signal provider type (http, schedule, slack, discord, etc.)
   */
  recordSignalTrigger(provider: string): void {
    if (!isEnabled || !signalTriggersCounter) return;
    signalTriggersCounter.add(1, { provider });
  },

  /**
   * Record an MCP tool call.
   * @param tool - Tool name that was invoked
   */
  recordMCPToolCall(tool: string): void {
    if (!isEnabled || !mcpToolCallsCounter) return;
    mcpToolCallsCounter.add(1, { tool });
  },
};
