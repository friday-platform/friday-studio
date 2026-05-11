/**
 * Thin wrapper around the OAuth mock Cloud Function for QA scenarios.
 *
 * The mock server itself lives in `tools/qa/fixtures/oauth-mock-server/` and
 * implements the same routes as the production Gemini CLI Workspace Extension
 * Cloud Function plus a control plane (`/control/mode`, `/control/counts`,
 * `/control/reset`). This module wraps the start/stop lifecycle and exposes
 * typed helpers for the scenario runner so individual scenarios don't have
 * to handcraft fetch calls.
 *
 * Scenario flow:
 *   const mock = await startMock(0);           // ephemeral port
 *   await mockControl(mock, { mode: "http_500_text" });
 *   ...drive daemon, observe behavior...
 *   const counts = await mockCounts(mock);
 *   await stopMock(mock);
 */

import {
  type MockOAuthMode,
  type MockOAuthServerHandle,
  startMockOAuthServer,
} from "../fixtures/oauth-mock-server/server.ts";

export type { MockOAuthMode } from "../fixtures/oauth-mock-server/server.ts";

export interface MockHandle {
  /** Base URL the daemon should point at via the FRIDAY_OAUTH_MOCK_* env vars. */
  url: string;
  /** Underlying server handle. Stop via stopMock(handle). */
  server: MockOAuthServerHandle;
}

export interface MockCounts {
  total: number;
  byMode: Record<string, number>;
  flakyCallCount: number;
}

export interface MockControlOptions {
  /** New /refreshToken response shape. Required when changing modes. */
  mode?: MockOAuthMode;
  /**
   * Mode-specific payload. For `"flaky"` this is the mode used for the
   * non-first call (defaults to `"success"`).
   */
  payload?: unknown;
  /** Reset counts before/after mode switch. Independent of mode change. */
  resetCounts?: boolean;
}

/**
 * Start a mock OAuth server on the given port (`0` = ephemeral).
 * The returned handle's `url` is what scenarios export as
 * `FRIDAY_OAUTH_MOCK_EXCHANGE_URI` / `FRIDAY_OAUTH_MOCK_REFRESH_URI` (with
 * `/refreshToken` appended for the refresh URI).
 */
export async function startMock(port: number = 0): Promise<MockHandle> {
  const server = await startMockOAuthServer(port);
  return { url: server.url, server };
}

export async function stopMock(handle: MockHandle): Promise<void> {
  await handle.server.stop();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCounts(value: unknown): MockCounts {
  if (!isPlainRecord(value)) {
    throw new Error("mock /control/counts returned a non-object body");
  }
  const total = value.total;
  const byMode = value.byMode;
  const flakyCallCount = value.flakyCallCount;
  if (typeof total !== "number") throw new Error("mock counts.total missing");
  if (typeof flakyCallCount !== "number") throw new Error("mock counts.flakyCallCount missing");
  if (!isPlainRecord(byMode)) throw new Error("mock counts.byMode missing");
  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(byMode)) {
    if (typeof v !== "number") throw new Error(`mock counts.byMode.${k} is not a number`);
    cleaned[k] = v;
  }
  return { total, byMode: cleaned, flakyCallCount };
}

/**
 * Drive the mock's control plane. Modes and reset are independent operations
 * so a scenario can flip the mode without resetting counts (or vice versa).
 *
 * The mock's reset endpoint clears both the mode (back to `"success"`) and
 * the counts. To preserve a mode while resetting counts, scenarios should
 * call `mockControl({ resetCounts: true })` BEFORE setting the desired mode.
 */
export async function mockControl(handle: MockHandle, options: MockControlOptions): Promise<void> {
  if (options.resetCounts === true) {
    const res = await fetch(`${handle.url}/control/reset`, { method: "POST" });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`mock /control/reset failed: ${res.status} ${text}`);
    }
    await res.body?.cancel();
  }
  if (options.mode !== undefined) {
    const body: Record<string, unknown> = { mode: options.mode };
    if (options.payload !== undefined) body.payload = options.payload;
    const res = await fetch(`${handle.url}/control/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`mock /control/mode failed: ${res.status} ${text}`);
    }
    await res.body?.cancel();
  }
}

export async function mockCounts(handle: MockHandle): Promise<MockCounts> {
  const res = await fetch(`${handle.url}/control/counts`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mock /control/counts failed: ${res.status} ${text}`);
  }
  return parseCounts(await res.json());
}
