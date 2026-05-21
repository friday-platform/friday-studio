/**
 * Tests for the cascade-worker / communicator setup-gate path.
 *
 * `evaluateWorkspaceSetupGate` is the context-free derivation used by
 * `triggerWorkspaceSignal` (schedule + fs-watch + queued HTTP) and the
 * communicator inbound handler. These tests exercise the gate end-to-end
 * with stubbed Link calls + stubbed workspace manager so we know:
 *   - unfilled declared variables flip the gate true
 *   - a fully-filled workspace clears the gate
 *   - missing workspace → null (caller has nothing to gate)
 *
 * The 409 body construction is covered separately by the HTTP route's own
 * integration test in `routes/workspaces/index.test.ts`.
 */

import type { WorkspaceManager } from "@atlas/workspace";
import { describe, expect, test, vi } from "vitest";

vi.mock("@atlas/workspace", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/workspace")>();
  return { ...original, loadWorkspaceEnv: vi.fn(() => ({})) };
});

const { mockResolveCredentialsByProvider, mockFetchLinkCredential } = vi.hoisted(() => ({
  mockResolveCredentialsByProvider: vi.fn(),
  mockFetchLinkCredential: vi.fn(),
}));

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  resolveCredentialsByProvider: mockResolveCredentialsByProvider,
  fetchLinkCredential: mockFetchLinkCredential,
}));

import {
  buildSetupRequired409Body,
  buildWorkspaceSetupUrl,
  classifyCascadeSetupError,
  evaluateWorkspaceSetupGate,
  SETUP_REQUIRED_ERROR_CODE,
  WorkspaceSetupRequiredError,
} from "./setup-required-gate.ts";

function makeManager(args: {
  workspace: object | null;
  config: Record<string, unknown> | null;
}): WorkspaceManager {
  return {
    find: vi.fn().mockResolvedValue(args.workspace),
    getWorkspaceConfig: vi.fn().mockResolvedValue(args.config),
  } as unknown as WorkspaceManager;
}

describe("evaluateWorkspaceSetupGate", () => {
  test("returns null when workspace is missing", async () => {
    const manager = makeManager({ workspace: null, config: null });
    const result = await evaluateWorkspaceSetupGate(manager, "ws-missing");
    expect(result).toBeNull();
  });

  test("returns null when workspace config is missing", async () => {
    const manager = makeManager({ workspace: { id: "ws-1", path: "/tmp/ws-1" }, config: null });
    const result = await evaluateWorkspaceSetupGate(manager, "ws-1");
    expect(result).toBeNull();
  });

  test("flips requires_setup true when a declared variable is unfilled", async () => {
    const manager = makeManager({
      workspace: { id: "ws-1", path: "/tmp/ws-1" },
      config: {
        workspace: {
          version: "1.0",
          workspace: { name: "Test" },
          variables: {
            email_recipient: {
              description: "Where to send the report",
              schema: { type: "string", minLength: 1 },
            },
          },
        },
      },
    });
    const result = await evaluateWorkspaceSetupGate(manager, "ws-1");
    expect(result).toEqual({ requires_setup: true, setupUrl: buildWorkspaceSetupUrl("ws-1") });
  });

  test("clears when there are no variable or credential requirements", async () => {
    const manager = makeManager({
      workspace: { id: "ws-2", path: "/tmp/ws-2" },
      config: { workspace: { version: "1.0", workspace: { name: "Test" } } },
    });
    const result = await evaluateWorkspaceSetupGate(manager, "ws-2");
    expect(result).toEqual({ requires_setup: false });
  });
});

describe("buildSetupRequired409Body / WorkspaceSetupRequiredError", () => {
  test("body shape locks in the keys webhook clients depend on", () => {
    const body = buildSetupRequired409Body("ws-x");
    expect(body.error).toBe(SETUP_REQUIRED_ERROR_CODE);
    expect(body.error).toBe("workspace_setup_required");
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.setup_url).toContain("/workspaces/ws-x/chat");
  });

  test("typed error preserves workspace + provider context", () => {
    const err = new WorkspaceSetupRequiredError({
      workspaceId: "ws-y",
      setupUrl: "http://daemon/workspaces/ws-y/chat",
      signalProvider: "schedule",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("workspace_setup_required");
    expect(err.workspaceId).toBe("ws-y");
    expect(err.signalProvider).toBe("schedule");
    expect(err.setupUrl).toContain("/workspaces/ws-y/chat");
  });
});

describe("classifyCascadeSetupError — Decision 7 cascade-consumer routing", () => {
  // Cron and fs-watch publish cascade envelopes without a correlationId
  // (no synchronous caller waiting on `signals.responses.<id>`). When the
  // setup-gate fires on the cascade dispatch, we don't want to rethrow —
  // the rethrow surfaces as a WARN log + (for HTTP callers only) a
  // fail-envelope publish. For cron/fs-watch the only honest outcome is
  // "skip cleanly + log info-level". HTTP callers always carry a
  // correlationId; for them the rethrow is load-bearing because the
  // correlated response subscriber is waiting for a fail envelope so the
  // route handler can return 409.

  const err = new WorkspaceSetupRequiredError({
    workspaceId: "ws-1",
    setupUrl: "http://daemon/workspaces/ws-1/chat",
    signalProvider: "schedule",
  });

  test("cron/fs-watch envelope (no correlationId) → skip cleanly", () => {
    const result = classifyCascadeSetupError(err, { correlationId: undefined });
    expect(result).toEqual({ action: "skip" });
  });

  test("HTTP envelope (correlationId set) → rethrow so the 409 surfaces", () => {
    const result = classifyCascadeSetupError(err, { correlationId: "abc-123" });
    expect(result).toEqual({ action: "rethrow" });
  });

  test("non-setup errors are passed through to the caller's existing handling", () => {
    const other = new Error("something else broke");
    expect(classifyCascadeSetupError(other, { correlationId: undefined })).toBeNull();
    expect(classifyCascadeSetupError(other, { correlationId: "abc" })).toBeNull();
  });
});
