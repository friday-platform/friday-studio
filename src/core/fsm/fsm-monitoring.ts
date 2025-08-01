/**
 * Monitoring and metrics utilities for FSMs in Atlas platform
 * Provides performance tracking, health monitoring, and metrics collection
 */

import { logger } from "@atlas/logger";
import { AtlasTelemetry } from "../../utils/telemetry.ts";

// Types for FSM monitoring
export interface FSMMetrics {
  machineId: string;
  instanceId: string;
  startTime: number;
  totalStateTransitions: number;
  stateTransitionTimes: Map<string, number[]>; // state -> array of transition times
  errorCounts: Map<string, number>; // error type -> count
  currentState: string;
  uptime: number;
  memoryUsage?: number;
  averageTransitionTime: number;
  errorRate: number;
}

export interface StateTransitionMetric {
  fromState: string;
  toState: string;
  duration: number;
  timestamp: number;
  event: string;
  success: boolean;
  errorType?: string;
}

export interface FSMHealthStatus {
  machineId: string;
  instanceId: string;
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  lastTransition: number;
  errorRate: number;
  averageResponseTime: number;
  issues: string[];
  recommendations: string[];
}

/**
 * FSM Performance Monitor - Tracks and analyzes FSM performance metrics
 */
export class FSMPerformanceMonitor {
  private metrics: Map<string, FSMMetrics> = new Map();
  private transitionHistory: Map<string, StateTransitionMetric[]> = new Map();
  private healthCheckInterval: number;
  private healthCheckTimer?: number;

  constructor(healthCheckIntervalMs: number = 30000, autoStart: boolean = true) {
    this.healthCheckInterval = healthCheckIntervalMs;
    if (autoStart) {
      this.startHealthChecking();
    }
  }

  /**
   * Registers a new FSM instance for monitoring
   * @param machineId - ID of the FSM type
   * @param instanceId - Unique ID of this FSM instance
   */
  registerFSM(machineId: string, instanceId: string): void {
    const key = `${machineId}:${instanceId}`;

    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        machineId,
        instanceId,
        startTime: Date.now(),
        totalStateTransitions: 0,
        stateTransitionTimes: new Map(),
        errorCounts: new Map(),
        currentState: "unknown",
        uptime: 0,
        averageTransitionTime: 0,
        errorRate: 0,
      });

      this.transitionHistory.set(key, []);

      logger.info("FSM registered for monitoring", {
        machineId,
        instanceId,
        workerType: "fsm-monitor",
      });
    }
  }

  /**
   * Records a state transition for performance tracking
   * @param machineId - ID of the FSM type
   * @param instanceId - Unique ID of this FSM instance
   * @param transition - State transition details
   */
  recordStateTransition(
    machineId: string,
    instanceId: string,
    transition: StateTransitionMetric,
  ): void {
    const key = `${machineId}:${instanceId}`;
    const metrics = this.metrics.get(key);

    if (!metrics) {
      logger.warn("Attempted to record transition for unregistered FSM", {
        machineId,
        instanceId,
        transition: transition.event,
      });
      return;
    }

    // Update metrics
    metrics.totalStateTransitions++;
    metrics.currentState = transition.toState;
    metrics.uptime = Date.now() - metrics.startTime;

    // Track transition times for this state
    if (!metrics.stateTransitionTimes.has(transition.fromState)) {
      metrics.stateTransitionTimes.set(transition.fromState, []);
    }
    metrics.stateTransitionTimes.get(transition.fromState)!.push(transition.duration);

    // Track errors
    if (!transition.success && transition.errorType) {
      const currentCount = metrics.errorCounts.get(transition.errorType) || 0;
      metrics.errorCounts.set(transition.errorType, currentCount + 1);
    }

    // Calculate averages
    this.updateCalculatedMetrics(metrics);

    // Store transition history (keep last 100 transitions)
    const history = this.transitionHistory.get(key)!;
    history.push(transition);
    if (history.length > 100) {
      history.shift();
    }

    // Log significant events
    if (!transition.success) {
      logger.warn("FSM transition failed", {
        machineId,
        instanceId,
        fromState: transition.fromState,
        toState: transition.toState,
        event: transition.event,
        duration: transition.duration,
        errorType: transition.errorType,
        workerType: "fsm-monitor",
      });
    } else if (transition.duration > 5000) { // Log slow transitions
      logger.warn("Slow FSM transition detected", {
        machineId,
        instanceId,
        fromState: transition.fromState,
        toState: transition.toState,
        duration: transition.duration,
        workerType: "fsm-monitor",
      });
    }
  }

  /**
   * Gets current metrics for an FSM instance
   * @param machineId - ID of the FSM type
   * @param instanceId - Unique ID of this FSM instance
   * @returns Current metrics or undefined if not found
   */
  getMetrics(machineId: string, instanceId: string): FSMMetrics | undefined {
    const key = `${machineId}:${instanceId}`;
    const metrics = this.metrics.get(key);

    if (metrics) {
      // Update calculated fields before returning
      metrics.uptime = Date.now() - metrics.startTime;
      this.updateCalculatedMetrics(metrics);
    }

    return metrics;
  }

  /**
   * Gets health status for an FSM instance
   * @param machineId - ID of the FSM type
   * @param instanceId - Unique ID of this FSM instance
   * @returns Health status or undefined if not found
   */
  getHealthStatus(machineId: string, instanceId: string): FSMHealthStatus | undefined {
    const metrics = this.getMetrics(machineId, instanceId);
    if (!metrics) return undefined;

    const issues: string[] = [];
    const recommendations: string[] = [];
    let status: "healthy" | "degraded" | "unhealthy" = "healthy";

    // Check error rate
    if (metrics.errorRate > 0.1) { // >10% error rate
      status = "unhealthy";
      issues.push(`High error rate: ${(metrics.errorRate * 100).toFixed(1)}%`);
      recommendations.push("Investigate error patterns and implement better error handling");
    } else if (metrics.errorRate > 0.05) { // >5% error rate
      status = "degraded";
      issues.push(`Elevated error rate: ${(metrics.errorRate * 100).toFixed(1)}%`);
      recommendations.push("Monitor error trends and consider preventive measures");
    }

    // Check average response time
    if (metrics.averageTransitionTime > 10000) { // >10 seconds
      status = status === "healthy" ? "degraded" : "unhealthy";
      issues.push(`Slow transitions: ${metrics.averageTransitionTime}ms average`);
      recommendations.push("Optimize state transition logic and consider async patterns");
    } else if (metrics.averageTransitionTime > 5000) { // >5 seconds
      if (status === "healthy") status = "degraded";
      issues.push(`Moderate transition times: ${metrics.averageTransitionTime}ms average`);
      recommendations.push("Review transition performance and consider optimizations");
    }

    // Check for stuck states (no transitions in last 5 minutes)
    const timeSinceLastTransition = Date.now() - metrics.startTime;
    if (metrics.totalStateTransitions === 0 && timeSinceLastTransition > 300000) {
      status = "unhealthy";
      issues.push("No state transitions recorded in over 5 minutes");
      recommendations.push("Check if FSM is stuck or inactive");
    }

    return {
      machineId: metrics.machineId,
      instanceId: metrics.instanceId,
      status,
      uptime: metrics.uptime,
      lastTransition: metrics.startTime + metrics.uptime,
      errorRate: metrics.errorRate,
      averageResponseTime: metrics.averageTransitionTime,
      issues,
      recommendations,
    };
  }

  /**
   * Gets aggregated metrics for all instances of an FSM type
   * @param machineId - ID of the FSM type
   * @returns Aggregated metrics
   */
  getAggregatedMetrics(machineId: string): {
    machineId: string;
    instanceCount: number;
    totalTransitions: number;
    averageUptime: number;
    overallErrorRate: number;
    averageTransitionTime: number;
    healthyInstances: number;
    degradedInstances: number;
    unhealthyInstances: number;
  } {
    const instances = Array.from(this.metrics.entries())
      .filter(([key]) => key.startsWith(`${machineId}:`))
      .map(([, metrics]) => metrics);

    if (instances.length === 0) {
      return {
        machineId,
        instanceCount: 0,
        totalTransitions: 0,
        averageUptime: 0,
        overallErrorRate: 0,
        averageTransitionTime: 0,
        healthyInstances: 0,
        degradedInstances: 0,
        unhealthyInstances: 0,
      };
    }

    const totalTransitions = instances.reduce((sum, m) => sum + m.totalStateTransitions, 0);
    const averageUptime = instances.reduce((sum, m) => sum + m.uptime, 0) / instances.length;
    const overallErrorRate = instances.reduce((sum, m) => sum + m.errorRate, 0) / instances.length;
    const averageTransitionTime = instances.reduce((sum, m) => sum + m.averageTransitionTime, 0) /
      instances.length;

    // Count health statuses
    let healthyInstances = 0;
    let degradedInstances = 0;
    let unhealthyInstances = 0;

    instances.forEach((metrics) => {
      const health = this.getHealthStatus(metrics.machineId, metrics.instanceId);
      if (health) {
        switch (health.status) {
          case "healthy":
            healthyInstances++;
            break;
          case "degraded":
            degradedInstances++;
            break;
          case "unhealthy":
            unhealthyInstances++;
            break;
        }
      }
    });

    return {
      machineId,
      instanceCount: instances.length,
      totalTransitions,
      averageUptime,
      overallErrorRate,
      averageTransitionTime,
      healthyInstances,
      degradedInstances,
      unhealthyInstances,
    };
  }

  /**
   * Exports metrics in a format suitable for telemetry systems
   * @param machineId - Optional filter by machine ID
   * @returns Metrics in telemetry format
   */
  exportTelemetryMetrics(machineId?: string): Record<string, any> {
    const allMetrics = Array.from(this.metrics.entries())
      .filter(([key]) => !machineId || key.startsWith(`${machineId}:`))
      .map(([key, metrics]) => ({
        key,
        ...metrics,
        stateTransitionTimes: Object.fromEntries(
          Array.from(metrics.stateTransitionTimes.entries())
            .map(([state, times]) => [state, {
              count: times.length,
              average: times.reduce((sum, t) => sum + t, 0) / times.length,
              min: Math.min(...times),
              max: Math.max(...times),
            }]),
        ),
        errorCounts: Object.fromEntries(metrics.errorCounts),
      }));

    return {
      timestamp: new Date().toISOString(),
      metrics: allMetrics,
      summary: machineId ? this.getAggregatedMetrics(machineId) : {
        totalFSMs: this.metrics.size,
        totalMachineTypes: new Set(Array.from(this.metrics.values()).map((m) => m.machineId)).size,
      },
    };
  }

  /**
   * Unregisters an FSM instance (cleanup)
   * @param machineId - ID of the FSM type
   * @param instanceId - Unique ID of this FSM instance
   */
  unregisterFSM(machineId: string, instanceId: string): void {
    const key = `${machineId}:${instanceId}`;

    const metrics = this.metrics.get(key);
    if (metrics) {
      logger.info("FSM unregistered from monitoring", {
        machineId,
        instanceId,
        uptime: metrics.uptime,
        totalTransitions: metrics.totalStateTransitions,
        workerType: "fsm-monitor",
      });

      this.metrics.delete(key);
      this.transitionHistory.delete(key);
    }
  }

  /**
   * Starts periodic health checking
   */
  private startHealthChecking(): void {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.healthCheckInterval);
  }

  /**
   * Stops periodic health checking
   */
  stopHealthChecking(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Performs a health check on all registered FSMs
   */
  private performHealthCheck(): void {
    const healthStatuses: FSMHealthStatus[] = [];

    for (const [key, metrics] of this.metrics.entries()) {
      const health = this.getHealthStatus(metrics.machineId, metrics.instanceId);
      if (health) {
        healthStatuses.push(health);
      }
    }

    const unhealthyCount = healthStatuses.filter((h) => h.status === "unhealthy").length;
    const degradedCount = healthStatuses.filter((h) => h.status === "degraded").length;
    const healthyCount = healthStatuses.filter((h) => h.status === "healthy").length;

    logger.info("FSM health check completed", {
      totalFSMs: healthStatuses.length,
      healthy: healthyCount,
      degraded: degradedCount,
      unhealthy: unhealthyCount,
      workerType: "fsm-monitor",
    });

    // Log unhealthy FSMs
    healthStatuses
      .filter((h) => h.status === "unhealthy")
      .forEach((health) => {
        logger.warn("Unhealthy FSM detected", {
          machineId: health.machineId,
          instanceId: health.instanceId,
          issues: health.issues,
          recommendations: health.recommendations,
          workerType: "fsm-monitor",
        });
      });
  }

  /**
   * Updates calculated metrics (averages, rates, etc.)
   */
  private updateCalculatedMetrics(metrics: FSMMetrics): void {
    // Calculate average transition time
    const allTransitionTimes: number[] = [];
    for (const times of metrics.stateTransitionTimes.values()) {
      allTransitionTimes.push(...times);
    }

    if (allTransitionTimes.length > 0) {
      metrics.averageTransitionTime = allTransitionTimes.reduce((sum, t) => sum + t, 0) /
        allTransitionTimes.length;
    }

    // Calculate error rate
    const totalErrors = Array.from(metrics.errorCounts.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
    metrics.errorRate = metrics.totalStateTransitions > 0
      ? totalErrors / metrics.totalStateTransitions
      : 0;

    // Update memory usage if available (Deno environment)
    try {
      if (typeof Deno !== "undefined" && Deno.memoryUsage) {
        metrics.memoryUsage = Deno.memoryUsage().heapUsed;
      }
    } catch {
      // Memory usage not available in this environment
    }
  }
}

/**
 * FSM Monitoring Decorator - Automatically tracks FSM performance
 */
export function createFSMMonitoringDecorator(monitor: FSMPerformanceMonitor) {
  return {
    /**
     * Decorates an FSM to automatically track transitions
     * @param machineId - ID of the FSM type
     * @param instanceId - Unique ID of this FSM instance
     * @returns Decorator function for XState machine setup
     */
    decorateFSM: (machineId: string, instanceId: string) => {
      // Register the FSM for monitoring
      monitor.registerFSM(machineId, instanceId);

      return {
        actions: {
          recordTransition: ({ context, event }: { context: any; event: any }) => {
            const transitionStart = context._monitoringTransitionStart || Date.now();
            const duration = Date.now() - transitionStart;

            monitor.recordStateTransition(machineId, instanceId, {
              fromState: context._monitoringPreviousState || "unknown",
              toState: String(context._currentState || "unknown"),
              duration,
              timestamp: Date.now(),
              event: event.type || "unknown",
              success: true,
            });
          },

          recordError: ({ context, event }: { context: any; event: any }) => {
            const transitionStart = context._monitoringTransitionStart || Date.now();
            const duration = Date.now() - transitionStart;

            monitor.recordStateTransition(machineId, instanceId, {
              fromState: context._monitoringPreviousState || "unknown",
              toState: String(context._currentState || "error"),
              duration,
              timestamp: Date.now(),
              event: event.type || "ERROR",
              success: false,
              errorType: event.error instanceof Error ? event.error.constructor.name : "unknown",
            });
          },

          prepareTransition: ({ context }: { context: any }) => {
            context._monitoringTransitionStart = Date.now();
            context._monitoringPreviousState = context._currentState;
          },
        },

        guards: {
          // No additional guards needed for monitoring
        },
      };
    },

    /**
     * Cleanup function to unregister FSM when it's done
     * @param machineId - ID of the FSM type
     * @param instanceId - Unique ID of this FSM instance
     */
    cleanup: (machineId: string, instanceId: string) => {
      monitor.unregisterFSM(machineId, instanceId);
    },
  };
}

// Export global monitor instance without auto-starting health checks
// Health checking will be started manually when needed (e.g., for daemon processes)
export const globalFSMMonitor = new FSMPerformanceMonitor(30000, false);

// Export utilities
export const FSMMonitoring = {
  FSMPerformanceMonitor,
  createFSMMonitoringDecorator,
  globalFSMMonitor,
};

export default FSMMonitoring;
