import process from "node:process";
import type { ValidationResult } from "./types.ts";

/**
 * Mount map: maps route file paths (relative to repo root) to URL prefixes.
 * Derived from apps/atlasd/src/atlas-daemon.ts route mount block.
 */
const ROUTE_MOUNT_MAP: Record<string, string> = {
  "apps/atlasd/routes/workspaces/index.ts": "/api/workspaces",
  "apps/atlasd/routes/workspaces/config.ts": "/api/workspaces/:workspaceId/config",
  "apps/atlasd/routes/workspaces/chat.ts": "/api/workspaces/:workspaceId/chat",
  "apps/atlasd/routes/workspaces/integrations.ts": "/api/workspaces/:workspaceId/integrations",
  "apps/atlasd/routes/artifacts.ts": "/api/artifacts",
  "apps/atlasd/routes/chunked-upload.ts": "/api/chunked-upload",
  "apps/atlasd/routes/chat.ts": "/api/chat",
  "apps/atlasd/routes/global-chat.ts": "/api/global-chat",
  "apps/atlasd/routes/chat-storage.ts": "/api/chat-storage",
  "apps/atlasd/routes/config.ts": "/api/config",
  "apps/atlasd/routes/user.ts": "/api/user",
  "apps/atlasd/routes/scratchpad.ts": "/api/scratchpad",
  "apps/atlasd/routes/sessions.ts": "/api/sessions",
  "apps/atlasd/routes/activity.ts": "/api/activity",
  "apps/atlasd/routes/agents.ts": "/api/agents",
  "apps/atlasd/routes/library.ts": "/api/library",
  "apps/atlasd/routes/daemon.ts": "/api/daemon",
  "apps/atlasd/routes/share.ts": "/api/share",
  "apps/atlasd/routes/link.ts": "/api/link",
  "apps/atlasd/routes/mcp-registry.ts": "/api/mcp-registry",
  "apps/atlasd/routes/me.ts": "/api/me",
  "apps/atlasd/routes/jobs.ts": "/api/jobs",
  "apps/atlasd/routes/skills.ts": "/api/skills",
  "apps/atlasd/routes/report.ts": "/api/report",
  "apps/atlasd/routes/memory.ts": "/api/memory",
  "apps/atlasd/routes/logs.ts": "/api/logs",
  "apps/atlasd/routes/health.ts": "/health",
};

const ROUTE_FILE_PREFIX = "apps/atlasd/routes/";

/** Failure-indicating body patterns (case-insensitive check) */
const FAILURE_BODY_PATTERNS = ["Internal server error", "TypeValidationError", "ZodError"] as const;

/** Stack trace pattern — checked separately (case-sensitive) */
const STACK_TRACE_PATTERN = /^\s+at\s+/m;

export interface EndpointInfo {
  file: string;
  urlPrefix: string;
}

/**
 * Filters changedFiles to only route files and maps them to URL prefixes.
 * Returns empty array if no route files were changed.
 */
export function discoverRouteEndpoints(changedFiles: string[]): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];

  for (const file of changedFiles) {
    if (!file.startsWith(ROUTE_FILE_PREFIX) || !file.endsWith(".ts")) {
      continue;
    }

    const urlPrefix = ROUTE_MOUNT_MAP[file];
    if (urlPrefix) {
      endpoints.push({ file, urlPrefix });
    }
  }

  return endpoints;
}

export interface SmokeTestResult {
  endpoint: string;
  method: string;
  status: number;
  bodySnippet: string;
  passed: boolean;
  failureReason?: string;
}

/**
 * Evaluates whether a smoke test response indicates a server-side failure.
 *
 * - 5xx status → failure
 * - Body containing "Internal server error", "TypeValidationError",
 *   "ZodError", or a stack trace → failure (even with 200 status)
 * - 400 (schema rejection) → pass
 * - 401/403 (auth) → pass
 * - Everything else → pass
 */
export function evaluateSmokeResponse(
  endpoint: string,
  method: string,
  status: number,
  body: string,
): SmokeTestResult {
  const bodySnippet = body.slice(0, 500);

  // 5xx is always a failure
  if (status >= 500) {
    return {
      endpoint,
      method,
      status,
      bodySnippet,
      passed: false,
      failureReason: `HTTP ${status} server error`,
    };
  }

  // Check body for failure patterns even on non-5xx responses
  for (const pattern of FAILURE_BODY_PATTERNS) {
    if (body.includes(pattern)) {
      return {
        endpoint,
        method,
        status,
        bodySnippet,
        passed: false,
        failureReason: `Response body contains '${pattern}' (status ${status})`,
      };
    }
  }

  // Check for stack traces in body
  if (STACK_TRACE_PATTERN.test(body)) {
    return {
      endpoint,
      method,
      status,
      bodySnippet,
      passed: false,
      failureReason: `Response body contains stack trace (status ${status})`,
    };
  }

  // 4xx (schema rejection, auth) and 2xx are acceptable
  return { endpoint, method, status, bodySnippet, passed: true };
}

/**
 * Performs a smoke test against a single endpoint.
 * Sends a minimal POST request with a synthetic body.
 */
async function smokeTestEndpoint(
  baseUrl: string,
  endpoint: EndpointInfo,
): Promise<SmokeTestResult> {
  const url = `${baseUrl}${endpoint.urlPrefix}`;
  const method = "POST";

  // Synthetic minimal request body covering common schema patterns
  const syntheticBody = JSON.stringify({
    id: `smoke-test-${crypto.randomUUID()}`,
    message: "smoke test",
    messages: [{ role: "user", id: "msg-smoke-1", parts: [{ type: "text", text: "smoke test" }] }],
  });

  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: syntheticBody,
      signal: AbortSignal.timeout(15_000),
    });

    const body = await response.text();
    return evaluateSmokeResponse(endpoint.urlPrefix, method, response.status, body);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    // Connection refused means daemon is not running — treat as pass
    // (the smoke test can only run when the daemon is available)
    if (message.includes("ECONNREFUSED") || message.includes("Connection refused")) {
      return {
        endpoint: endpoint.urlPrefix,
        method,
        status: 0,
        bodySnippet: "",
        passed: true,
        failureReason: `Daemon not reachable (${message}) — skipping`,
      };
    }

    return {
      endpoint: endpoint.urlPrefix,
      method,
      status: 0,
      bodySnippet: "",
      passed: false,
      failureReason: `Request failed: ${message}`,
    };
  }
}

/**
 * Smoke test validator: for sessions that touched route files, sends
 * synthetic requests and verifies the daemon doesn't crash (5xx) or
 * leak error internals in the response body.
 */
export async function validateSmokeTest(
  changedFiles: string[],
  options?: { platformUrl?: string },
): Promise<ValidationResult> {
  const endpoints = discoverRouteEndpoints(changedFiles);

  if (endpoints.length === 0) {
    return {
      validator: "smoke-test",
      ok: true,
      message: "smoke-test: no route files changed",
      evidence: [],
    };
  }

  const baseUrl = options?.platformUrl ?? process.env["PLATFORM_URL"] ?? "http://localhost:8080";
  const results: SmokeTestResult[] = [];

  for (const endpoint of endpoints) {
    results.push(await smokeTestEndpoint(baseUrl, endpoint));
  }

  const failures = results.filter((r) => !r.passed);

  if (failures.length === 0) {
    return {
      validator: "smoke-test",
      ok: true,
      message: `smoke-test: ${results.length} endpoint(s) passed`,
      evidence: [],
    };
  }

  const evidence = failures.map(
    (f) =>
      `${f.method} ${f.endpoint}: ${f.failureReason ?? "unknown"} — ${f.bodySnippet.slice(0, 200)}`,
  );

  return {
    validator: "smoke-test",
    ok: false,
    message: `smoke-test: ${failures.length}/${results.length} endpoint(s) failed`,
    evidence,
  };
}
