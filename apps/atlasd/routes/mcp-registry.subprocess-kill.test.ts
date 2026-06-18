// End-to-end verification for issue #344. A real `Deno.serve` hosts the
// MCP-registry router; a real Node `fetch` with `AbortController` calls
// `GET /:id/tools`; the route spawns a real slow stdio MCP server; we
// abort the client; we assert the spawned subprocess is gone within ~2s.
//
// Unlike `apps/atlasd/routes/mcp-registry.test.ts`, this file intentionally
// does NOT mock `@atlas/mcp` — proving the abort path actually reaches the
// spawned child and kills it is the whole point. Living in its own file
// keeps `vi.mock` scope from polluting either suite.
//
// PID capture uses the `pgrep -P <test-pid>` baseline-then-diff pattern
// established by `packages/mcp/src/create-mcp-tools.subprocess-kill.test.ts`
// (Vitest's frozen ESM namespaces make `vi.spyOn(child_process, "spawn")`
// throw "Cannot redefine property", so we read the OS process tree instead).

import { execFileSync } from "node:child_process";
import process from "node:process";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, it } from "vitest";
import { mcpRegistryRouter } from "./mcp-registry.ts";
import { _resetCacheForTest } from "./mcp-tool-cache.ts";

// Same slow MCP server used by `create-mcp-tools.subprocess-kill.test.ts`:
// keeps the event loop alive (setInterval), holds stdin open, and never
// responds to the MCP `initialize` handshake — so `experimental_createMCPClient`
// hangs until the transport's AbortController fires SIGTERM.
const SLOW_SERVER_SCRIPT = "setInterval(() => {}, 1000); process.stdin.resume();";

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
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
}

// Read a single pid's command line via `ps -o command=` — portable across
// macOS and Linux. Returns "" if the pid is gone by the time we ask, so
// the caller treats it as a non-match.
function cmdlineFor(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// Filter candidate child PIDs by command line so a concurrent test's spawn
// can't be picked up as ours. The `cmdlineMatch` substring must be unique
// to this test's slow-server script (see SLOW_SERVER_SCRIPT).
async function waitForNewChild(
  baseline: Set<number>,
  timeoutMs: number,
  cmdlineMatch: string,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pid of listChildren(process.pid)) {
      if (baseline.has(pid)) continue;
      if (cmdlineFor(pid).includes(cmdlineMatch)) return pid;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for spawned child to appear");
}

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

// POSIX-only — same skip rationale as `create-mcp-tools.subprocess-kill.test.ts`.
// The daemon doesn't run on Windows; `pgrep` and `process.kill(pid, 0)` ESRCH
// semantics aren't portable.
describe.skipIf(process.platform === "win32")(
  "GET /:id/tools — client abort kills spawned stdio subprocess (#344)",
  () => {
    let server: Deno.HttpServer<Deno.NetAddr> | undefined;
    let baseUrl: string | undefined;
    const trackedPids = new Set<number>();
    const seededIds = new Set<string>();

    beforeEach(async () => {
      _resetCacheForTest();

      // Build a Hono app that mounts the registry router under "/". The
      // production daemon mounts at "/api/mcp-registry"; the prefix doesn't
      // affect what we're testing (abort propagation through the handler),
      // and a flat mount keeps URLs short.
      const app = new Hono();
      app.use("*", async (c, next) => {
        // @ts-expect-error - the registry route never reads `app` context.
        c.set("app", {});
        // @ts-expect-error - userId Variables not typed on bare Hono app
        c.set("userId", "test-user");
        await next();
      });
      app.route("/", mcpRegistryRouter);

      // Port 0 → OS picks a free port. Bind to loopback so the test doesn't
      // need network permissions beyond localhost.
      const ready = Promise.withResolvers<void>();
      server = Deno.serve(
        {
          port: 0,
          hostname: "127.0.0.1",
          onListen: ({ hostname, port }) => {
            baseUrl = `http://${hostname}:${port}`;
            ready.resolve();
          },
        },
        app.fetch,
      );
      await ready.promise;
    });

    afterEach(async () => {
      // Kill any subprocess the test failed to clean up — otherwise the
      // next test's `pgrep -P` baseline picks it up as a stray.
      for (const pid of trackedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      trackedPids.clear();

      // Drop dynamic registry entries so the JetStream KV bucket (shared
      // across the worker) doesn't accumulate test fixtures.
      if (seededIds.size > 0) {
        const adapter = await getMCPRegistryAdapter();
        for (const id of seededIds) {
          await adapter.delete(id).catch(() => {});
        }
        seededIds.clear();
      }

      if (server) {
        await server.shutdown();
        server = undefined;
        baseUrl = undefined;
      }
    });

    it("aborts the request → SIGTERMs the stdio child within ~2s", async () => {
      if (!baseUrl) throw new Error("server did not start");

      // Random suffix because the JetStream KV bucket is shared across the
      // worker and prior runs may have leaked. Also guards against any
      // accidental overlap with a blessed-registry id.
      const serverId = `subprocess-kill-test-${crypto.randomUUID().slice(0, 8)}`;
      if (mcpServersRegistry.servers[serverId]) {
        throw new Error(`unexpected blessed-registry collision on ${serverId}`);
      }

      const adapter = await getMCPRegistryAdapter();
      await adapter.add({
        id: serverId,
        name: "Subprocess kill test",
        source: "web",
        securityRating: "medium",
        status: "ready",
        configTemplate: {
          transport: { type: "stdio", command: "node", args: ["-e", SLOW_SERVER_SCRIPT] },
        },
      });
      seededIds.add(serverId);

      const baseline = new Set(listChildren(process.pid));
      const controller = new AbortController();
      const fetchPromise = fetch(`${baseUrl}/${serverId}/tools`, { signal: controller.signal });
      // Swallow the rejection that lands when we abort — we assert on the
      // subprocess PID, not the fetch promise.
      fetchPromise.catch(() => {});

      const pid = await waitForNewChild(baseline, 3000, SLOW_SERVER_SCRIPT);
      trackedPids.add(pid);

      controller.abort();
      await expectPidGone(pid, 2000);
      trackedPids.delete(pid);
    }, 15_000);
  },
);
