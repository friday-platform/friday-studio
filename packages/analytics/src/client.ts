import type { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { env } from "node:process";
import { logger } from "@atlas/logger";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { AnalyticsClient, AnalyticsEvent } from "./types.ts";

let analyticsProvider: LoggerProvider | null = null;
let environment: string | null = null;

function getAnalyticsLogger() {
  const endpoint = env.ANALYTICS_OTEL_ENDPOINT;
  if (!endpoint) {
    return null;
  }

  if (!analyticsProvider) {
    logger.debug("Creating analytics provider", { endpoint });

    // Read CA certificate for TLS verification
    const certPath = env.OTEL_EXPORTER_OTLP_CERTIFICATE;
    let ca: Buffer | undefined;
    if (certPath) {
      try {
        ca = fs.readFileSync(certPath);
        logger.debug("Loaded CA certificate", { path: certPath, size: ca.length });
      } catch (err) {
        logger.warn("Failed to read CA certificate", { path: certPath, error: String(err) });
      }
    }

    const exporter = new OTLPLogExporter({
      url: endpoint,
      httpAgentOptions: ca ? { ca } : undefined,
    });
    const processor = new SimpleLogRecordProcessor(exporter);
    analyticsProvider = new LoggerProvider({ processors: [processor] });
    environment = env.ENVIRONMENT || "development";
  }
  return analyticsProvider.getLogger("analytics");
}

export function createAnalyticsClient(): AnalyticsClient {
  return {
    emit(event: AnalyticsEvent): void {
      logger.debug("Analytics emit() called", { eventName: event.eventName, userId: event.userId });
      const otelLogger = getAnalyticsLogger();
      if (!otelLogger) {
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

      logger.debug("Analytics emitting log record", {
        eventName: event.eventName,
        userId: event.userId,
      });
      otelLogger.emit({ severityNumber: SeverityNumber.INFO, body: event.eventName, attributes });
    },
    async shutdown(): Promise<void> {
      if (analyticsProvider) {
        await analyticsProvider.shutdown();
        analyticsProvider = null;
      }
    },
  };
}
