import * as Sentry from "@sentry/deno";
import { isInitialized } from "./init.ts";

interface CaptureContext {
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  [key: string]: unknown;
}

function applyContext(scope: Sentry.Scope, context?: CaptureContext): void {
  if (!context) return;
  if (context.workspaceId) scope.setTag("workspaceId", context.workspaceId);
  if (context.sessionId) scope.setTag("sessionId", context.sessionId);
  if (context.agentId) scope.setTag("agentId", context.agentId);
  if (context.agentName) scope.setTag("agentName", context.agentName);
  scope.setExtras(context);
}

function fingerprintForException(error: unknown): string[] {
  if (error instanceof Error) {
    return ["{{ default }}", error.name];
  }
  return ["{{ default }}"];
}

function fingerprintForMessage(message: string): string[] {
  return [message];
}

export function captureException(error: unknown, context?: CaptureContext): void {
  if (!isInitialized()) return;
  try {
    Sentry.withScope((scope) => {
      applyContext(scope, context);
      scope.setFingerprint(fingerprintForException(error));
      Sentry.captureException(error);
    });
  } catch {
    // Never throw from Sentry operations
  }
}

export function captureMessage(
  message: string,
  level: "fatal" | "error" | "warning" | "info" | "debug" = "error",
  context?: CaptureContext,
): void {
  if (!isInitialized()) return;
  try {
    Sentry.withScope((scope) => {
      applyContext(scope, context);
      scope.setFingerprint(fingerprintForMessage(message));
      Sentry.captureMessage(message, level);
    });
  } catch {
    // Never throw from Sentry operations
  }
}
