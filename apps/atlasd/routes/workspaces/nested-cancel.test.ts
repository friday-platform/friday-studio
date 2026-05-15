/**
 * End-to-end test #26: nested signal cancellation via fetch-abort chain.
 *
 * Justifies the v2 design's no-`forwardCancelToChild`-helper decision by
 * proving the existing wire-up already aborts a nested job_tool cascade
 * within 2s of the parent chat turn's abort.
 *
 * The chain exercised here:
 *   parent AbortController (the per-turn one from `chatTurnRegistry`)
 *     → `createJobTools(..., abortSignal)` parameter
 *     → `executeJobViaJSON` reads it as `init.signal` on the Hono RPC
 *       `$post` (#24 wired this in)
 *     → mocked `$post` delegates to `app.request(..., { signal })` so the
 *       in-process Hono router sees the same signal on `c.req.raw.signal`
 *     → daemon route's bypass branch
 *       (`routes/workspaces/index.ts:2014-2044`) forwards
 *       `c.req.raw.signal` as the 7th arg of `triggerWorkspaceSignal`
 *     → the stubbed daemon captures that arg; we assert it aborts.
 *
 * Why we observe the in-process `abortSignal` arg and NOT a
 * `signals.cancel.<correlationId>` NATS frame — even though the v2 design
 * doc's test-#9 sketch says we should:
 *
 * `executeJobViaJSON` hardcodes `bypassConcurrency: true` (see
 * `packages/system/agents/workspace-chat/tools/job-tools.ts:203`). That
 * routes the request through the **bypass branch** at lines 2014-2044 of
 * `apps/atlasd/routes/workspaces/index.ts`, which calls
 * `ctx.daemon.triggerWorkspaceSignal(..., c.req.raw.signal, ...)`
 * directly. Both `publishSignalCancellation()` call sites in that file
 * (lines 1783 and 2067) live in the **non-bypass** branches — the bypass
 * path's abort propagation is purely in-process. So `signals.cancel.*`
 * never fires for a job_tool-spawned signal; the honest end-to-end
 * observable is the abortSignal arg flipping `aborted = true`. This
 * discrepancy in the design doc is captured in
 * `docs/learnings/2026-05-12-improved-cancelation.md` under
 * "Design-doc errata".
 *
 * The MCP `workspace_signal_trigger` path (task #25) DOES go through the
 * non-bypass branch and DOES publish a cancel frame — that's covered by
 * `apps/atlasd/routes/workspaces/index.test.ts:929` and `:967`. Different
 * caller, different branch, different observable. Don't conflate them.
 */

import process from "node:process";
import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";

// Mock `@atlas/client/v2` so the JSON job_tool's `$post` is redirected
// into our in-process Hono app via `app.request(...)`. The `init.signal`
// from #24's wiring is forwarded as the `signal` of the synthesized
// Request, which Hono surfaces as `c.req.raw.signal` — same path a real
// fetch would take in production.
//
// `appHolder` is mutated by the test before each call so the mock can
// reach the freshly-built app without hoisting issues.
const appHolder: { app: Hono<AppVariables> | null } = vi.hoisted(() => ({ app: null }));

vi.mock("@atlas/client/v2", () => {
  type PostInit = { signal?: AbortSignal };
  type PostHeaders = Record<string, string>;
  type PostOpts = { init?: PostInit; headers?: PostHeaders };
  type PostRequest = {
    param: { workspaceId: string; signalId: string };
    json: Record<string, unknown>;
  };

  const $post = (request: PostRequest, opts: PostOpts = {}) => {
    if (!appHolder.app) throw new Error("test app not configured");
    return appHolder.app.request(
      `/workspaces/${request.param.workspaceId}/signals/${request.param.signalId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
        body: JSON.stringify(request.json),
        signal: opts.init?.signal,
      },
    );
  };

  return {
    client: { workspace: { ":workspaceId": { signals: { ":signalId": { $post } } } } },
    parseResult: async (promise: Promise<Response>) => {
      try {
        const res = await promise;
        if (!res.ok) return { ok: false, error: new Error(`HTTP ${res.status}`) };
        const data = (await res.json()) as unknown;
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error };
      }
    },
    DetailedError: class extends Error {},
  };
});

// Static import after vi.mock (vi.mock is hoisted): `createJobTools`
// pulls the mocked `client` from `@atlas/client/v2` when invoked.
import type { JobSpecification } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { createJobTools } from "../../../../packages/system/agents/workspace-chat/tools/job-tools.ts";

import { workspacesRoutes } from "./index.ts";

vi.mock("../me/adapter.ts", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ ok: false }) }));

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: {
    get: vi
      .fn()
      .mockImplementation((userId: string, wsId: string) =>
        Promise.resolve({
          ok: true,
          data: { userId, wsId, role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
        }),
      ),
    listByUser: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } satisfies Record<keyof Logger, unknown>;
}

const BYPASS_TOKEN_ENV = "FRIDAY_INTERNAL_SIGNAL_BYPASS_TOKEN";

describe("nested signal cancellation via fetch-abort chain (task #26)", () => {
  let previousBypassToken: string | undefined;

  beforeEach(() => {
    previousBypassToken = process.env[BYPASS_TOKEN_ENV];
    // job-tools.ts only attaches the bypass header when this env var is
    // set; the route's bypass branch only accepts the header when the
    // token matches. Both halves of the handshake must align or the
    // route returns 403 before forwarding the abort signal.
    process.env[BYPASS_TOKEN_ENV] = "test-token";
  });

  afterEach(() => {
    if (previousBypassToken === undefined) delete process.env[BYPASS_TOKEN_ENV];
    else process.env[BYPASS_TOKEN_ENV] = previousBypassToken;
    appHolder.app = null;
  });

  test("parent abort propagates to triggerWorkspaceSignal's abortSignal arg within 2s", async () => {
    // Captures the 7th positional arg of `triggerWorkspaceSignal`, which
    // is the AbortSignal the daemon forwards into the workspace runtime.
    // The stub returns a promise that resolves only when the signal
    // aborts — that mimics a real spawned session parked on inner work
    // and gives the parent abort time to traverse the full chain before
    // the request unblocks.
    let capturedSignal: AbortSignal | undefined;
    const triggerWorkspaceSignal = vi.fn(
      async (
        _wsId: string,
        _sigId: string,
        _payload: Record<string, unknown> | undefined,
        _streamId: string | undefined,
        _onStreamEvent: ((chunk: AtlasUIMessageChunk) => void) | undefined,
        _skipStates: string[] | undefined,
        abortSignal: AbortSignal | undefined,
        _parentSessionId: string | undefined,
      ) => {
        capturedSignal = abortSignal;
        await new Promise<void>((resolve) => {
          if (!abortSignal) {
            resolve();
            return;
          }
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { sessionId: "sess-aborted", output: [], artifactIds: [], summary: "" };
      },
    );

    const mockWorkspaceManager = {
      find: vi.fn().mockResolvedValue({ id: "ws-1", path: "/tmp/ws-1", name: "Test" }),
      list: vi.fn().mockResolvedValue([]),
      getWorkspaceConfig: vi.fn().mockResolvedValue(null),
      registerWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
    } as unknown as WorkspaceManager;

    const mockContext: AppContext = {
      runtimes: new Map(),
      startTime: Date.now(),
      sseClients: new Map(),
      sseStreams: new Map(),
      getWorkspaceManager: () => mockWorkspaceManager,
      getOrCreateWorkspaceRuntime: vi.fn(),
      resetIdleTimeout: vi.fn(),
      getWorkspaceRuntime: vi.fn(),
      destroyWorkspaceRuntime: vi.fn(),
      getAgentRegistry: vi.fn(),
      getOrCreateChatSdkInstance: vi.fn(),
      evictChatSdkInstance: vi.fn(),
      daemon: {
        getWorkspaceManager: () => mockWorkspaceManager,
        triggerWorkspaceSignal,
        runtimes: new Map(),
      } as unknown as AppContext["daemon"],
      streamRegistry: {} as AppContext["streamRegistry"],
      chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
      sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
      sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
      exposeKernel: false,
      platformModels: createStubPlatformModels(),
    };

    const app = new Hono<AppVariables>();
    app.use("*", async (c, next) => {
      c.set("app", mockContext);
      c.set("userId", "test-user");
      await next();
    });
    app.route("/workspaces", workspacesRoutes);
    appHolder.app = app;

    const parent = new AbortController();
    const job: JobSpecification = {
      execution: { strategy: "sequential", agents: ["test-agent"] },
      description: "Nested cancel target",
      triggers: [{ signal: "sig-1" }],
    };
    const tools = createJobTools(
      "ws-1",
      { "nested-job": job },
      {},
      makeLogger(),
      undefined,
      undefined,
      parent.signal,
    );
    const tool = tools["nested-job"];
    if (!tool?.execute) throw new Error("nested-job tool missing execute");

    // Fire the tool — internally calls executeJobViaJSON → mocked $post →
    // app.request → bypass route → triggerWorkspaceSignal (parked on
    // abortSignal). The result promise won't resolve until the stub
    // unblocks, which it only does once the parent signal aborts.
    const resultPromise = tool.execute(
      { prompt: "spawn nested" },
      { toolCallId: "tc-parent", messages: [] as never[] },
    );

    // Same 50ms invariant as the prior-art tests at index.test.ts:947 —
    // long enough for the route to capture the abortSignal arg before
    // we trigger the abort.
    await new Promise((r) => setTimeout(r, 50));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    parent.abort();

    // Race the captured-signal-aborts promise against a 2s ceiling. The
    // 2s budget mirrors the design's "nested cascade aborts within 2s"
    // outcome and the cb169cb prior-art timeout.
    const aborted = await Promise.race([
      new Promise<true>((resolve) => {
        if (capturedSignal?.aborted) {
          resolve(true);
          return;
        }
        capturedSignal?.addEventListener("abort", () => resolve(true), { once: true });
      }),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    expect(aborted).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);

    // Drain the in-flight request promise so the test doesn't leak it.
    // The mocked triggerWorkspaceSignal resolves once the signal aborts,
    // so this awaits the natural completion of the chain.
    await resultPromise;
  }, 5000);
});
