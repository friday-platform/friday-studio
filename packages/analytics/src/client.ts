import { env, stderr } from "node:process";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { AnalyticsClient, AnalyticsEvent } from "./types.ts";

let analyticsProvider: LoggerProvider | null = null;
let environment: string | null = null;

/** Debug logging to stderr (won't interfere with structured JSON logs) */
function debug(msg: string, data?: Record<string, unknown>): void {
  if (env.ANALYTICS_DEBUG === "true") {
    stderr.write(`[analytics] ${msg} ${data ? JSON.stringify(data) : ""}\n`);
  }
}

function getAnalyticsLogger() {
  const endpoint = env.ANALYTICS_OTEL_ENDPOINT;
  if (!endpoint) {
    debug("Analytics disabled - no ANALYTICS_OTEL_ENDPOINT");
    return null;
  }

  if (!analyticsProvider) {
    debug("Creating analytics provider", { endpoint });
    const exporter = new OTLPLogExporter({ url: endpoint });
    const processor = new SimpleLogRecordProcessor(exporter);
    analyticsProvider = new LoggerProvider({ processors: [processor] });
    environment = env.ENVIRONMENT || "development";
    debug("Analytics provider created", { environment });
  }
  return analyticsProvider.getLogger("analytics");
}

export function createAnalyticsClient(): AnalyticsClient {
  return {
    emit(event: AnalyticsEvent): void {
      debug("emit() called", { eventName: event.eventName, userId: event.userId });
      const logger = getAnalyticsLogger();
      if (!logger) {
        debug("emit() - no logger, returning early");
        return; // Analytics disabled - no endpoint configured
      }

      if (!event.userId?.trim()) {
        throw new Error(`Analytics event '${event.eventName}' missing userId`);
      }

      // Build attributes, only including optional fields if they have values
      const attributes: Record<string, string> = {
        "log.type": "analytics",
        event_name: event.eventName,
        event_id: crypto.randomUUID(),
        user_id: event.userId,
        environment: environment ?? "development",
      };

      if (event.workspaceId) attributes.workspace_id = event.workspaceId;
      if (event.sessionId) attributes.session_id = event.sessionId;
      if (event.conversationId) attributes.conversation_id = event.conversationId;
      if (event.jobName) attributes.job_name = event.jobName;

      debug("emit() - emitting log record", { attributes });
      logger.emit({ severityNumber: SeverityNumber.INFO, body: event.eventName, attributes });
      debug("emit() - log record emitted");
    },
    async shutdown(): Promise<void> {
      if (analyticsProvider) {
        await analyticsProvider.shutdown();
        analyticsProvider = null;
      }
    },
  };
}
