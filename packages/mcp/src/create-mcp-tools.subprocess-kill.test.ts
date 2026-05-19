// Verifies the real invariant from the design doc (issue #344):
// when the abort signal fires — either externally (test A) or via the
// inner `withTimeout` firing through `connectServerWithTimeout`'s
// `AbortSignal.any` plumbing (test B) — the spawned stdio MCP subprocess
// is actually gone. "Promise rejected" is not enough; the orphan-leak
// regression mode passes the rejection test. The honest invariant is
// `process.kill(pid, 0)` throws ESRCH.
//
// This file intentionally does NOT mock `@ai-sdk/mcp` or its stdio
// transport — only the real spawn → real SIGTERM path proves the bug
// is fixed.

import { execFileSync } from "node:child_process";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { attemptStdio, MCPTimeoutError, withTimeout } from "./create-mcp-tools.ts";

// A "slow" MCP server: keeps the event loop alive and reads stdin so it
// doesn't exit on its own. It never responds to the MCP `initialize`
// handshake, so `experimental_createMCPClient` hangs until something
// aborts the transport — which is exactly the window we want to abort in.
const SLOW_SERVER_SCRIPT = "setInterval(() => {}, 1000); process.stdin.resume();";

// List direct children of the current process via `pgrep -P`. Vitest's
// ESM namespace is frozen, so we can't spy on `node:child_process.spawn`
// from the test — instead, snapshot the OS's process tree before and
// after `attemptStdio` spawns so we can identify the new child by diff.
function listChildren(parent: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8" });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  } catch (err) {
    // `pgrep -P` exits 1 when there are no matches — that's not an error
    // for us, it just means no children yet.
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
}

async function waitForNewChild(baseline: Set<number>, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pid of listChildren(process.pid)) {
      if (!baseline.has(pid)) return pid;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for spawned child to appear");
}

// `process.kill(pid, 0)` throws ESRCH when the pid no longer exists.
// Poll because SIGTERM → child exit → kernel reaping is asynchronous;
// 2s gives the OS plenty of headroom without making the test sluggish.
async function expectPidGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

// `process.kill(pid, 0)` ESRCH semantics are POSIX. Windows uses a
// different errno surface. The daemon does not run on Windows, but skip
// rather than emit a false failure if CI ever picks this up there.
describe.skipIf(process.platform === "win32")("attemptStdio subprocess teardown", () => {
  const trackedPids = new Set<number>();

  afterEach(() => {
    // Any child still alive at the end of a test means the test itself
    // leaked — kill it so the next test starts clean.
    for (const pid of trackedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    trackedPids.clear();
  });

  it("kills the spawned child when the external signal aborts mid-handshake", async () => {
    const baseline = new Set(listChildren(process.pid));
    const controller = new AbortController();
    const promise = attemptStdio(
      "node",
      ["-e", SLOW_SERVER_SCRIPT],
      { ...(process.env as Record<string, string>) },
      controller.signal,
    );

    const pid = await waitForNewChild(baseline, 2000);
    trackedPids.add(pid);

    controller.abort(new Error("client gone"));

    await expect(promise).rejects.toThrow("client gone");
    await expectPidGone(pid, 2000);
    trackedPids.delete(pid);
  }, 10_000);

  it("kills the spawned child when withTimeout fires (reduced timeout)", async () => {
    // Mirrors `connectServerWithTimeout` (packages/mcp/src/create-mcp-tools.ts)
    // with a 200ms timeout instead of the production 20s. The production
    // wiring is: internal `AbortController` + downstream `AbortSignal.any`
    // combining it with the external signal + `timeoutController.abort(err)`
    // called from inside `withTimeout`'s `makeError` callback. We reproduce
    // that here so the timer firing reaches `attemptStdio`'s registered
    // listener via the same signal-propagation path.
    //
    // IF `connectServerWithTimeout` CHANGES ITS SIGNAL COMPOSITION (e.g.
    // drops `AbortSignal.any`, moves the `timeoutController.abort()` call,
    // or substitutes a different timeout primitive), THIS TEST WILL SILENTLY
    // KEEP PASSING WHILE NO LONGER TESTING THE REAL PATH. Mirror the change
    // here. The signal-aware behavior of `withTimeout` and the abort
    // listener in `attemptStdio` are what's actually under test; the
    // composition between them lives in `connectServerWithTimeout` and
    // is the load-bearing part to keep in sync.
    const timeoutController = new AbortController();
    const baseline = new Set(listChildren(process.pid));

    const inner = attemptStdio(
      "node",
      ["-e", SLOW_SERVER_SCRIPT],
      { ...(process.env as Record<string, string>) },
      timeoutController.signal,
    );

    const promise = withTimeout(inner, 200, (actualDurationMs) => {
      const err = new MCPTimeoutError("slow-test", "list_tools", 200, actualDurationMs);
      timeoutController.abort(err);
      return err;
    });

    const pid = await waitForNewChild(baseline, 2000);
    trackedPids.add(pid);

    await expect(promise).rejects.toBeInstanceOf(MCPTimeoutError);
    await expectPidGone(pid, 2000);
    trackedPids.delete(pid);
  }, 10_000);
});
