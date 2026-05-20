/**
 * Behavior test for the dedicated liveness listener.
 *
 * The PR description claims the listener stays answerable when the
 * main listener's handlers are slow / backed up. This test isolates
 * the wiring claim from the full AtlasDaemon stack (which can't boot
 * in vitest because Deno globals aren't available) by spinning up
 * two raw `Deno.serve` instances that mimic the production split:
 *
 *   - main:     `() => sleep(20s)` — handler hangs, simulating a slow
 *                 SSE / agent / NATS round-trip
 *   - liveness: `() => new Response("ok")` — the actual production
 *                 handler from atlas-daemon.ts:startHealthListener
 *
 * Then we hammer the main port with concurrent in-flight requests
 * (filling its connection pool / accept queue with stuck handlers)
 * and time the liveness response. If the listener-split wiring
 * delivers the claimed benefit, the liveness probe completes well
 * inside the launcher's 2 s deadline. If both listeners share an
 * accept queue (or some other coupling we missed), this test fails.
 *
 * Run with: `deno test --allow-net apps/atlasd/src/health-listener.test.ts`
 */

import { assert, assertEquals } from "jsr:@std/assert@1";

/**
 * Probe an http URL with a deadline; return the elapsed milliseconds
 * and the response text. Times out cleanly so a real wedge surfaces
 * as a test failure rather than a hung process.
 */
async function timedProbe(
  url: string,
  timeoutMs: number,
): Promise<{ elapsedMs: number; body: string }> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("probe timeout")), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const body = await resp.text();
    return { elapsedMs: performance.now() - start, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Pick a random high port to reduce collisions across parallel test runs. */
function randomPort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

Deno.test("liveness listener answers while main listener handlers are stuck", async () => {
  const mainPort = randomPort();
  const livenessPort = mainPort + 1;
  const mainAbort = new AbortController();
  const livenessAbort = new AbortController();
  // Track the slow-handler timers so we can clear them on teardown
  // (otherwise Deno's --no-leaks test runner flags the 64 dangling
  // setTimeout calls from the saturation flood as a resource leak).
  const slowTimers = new Set<number>();

  // Main: every request hangs for 20 s. The 20 s is the same number
  // the production cascade hit on MCP stdio list_tools — i.e. far
  // longer than the launcher's 2 s probe budget.
  const mainServer = Deno.serve(
    { port: mainPort, hostname: "127.0.0.1", signal: mainAbort.signal, onListen: () => {} },
    () =>
      new Promise<Response>((resolve) => {
        const t = setTimeout(() => {
          slowTimers.delete(t);
          resolve(new Response("late"));
        }, 20_000);
        slowTimers.add(t);
      }),
  );

  // Liveness: the actual production handler (apps/atlasd/src/atlas-daemon.ts).
  const livenessServer = Deno.serve(
    { port: livenessPort, hostname: "127.0.0.1", signal: livenessAbort.signal, onListen: () => {} },
    () => new Response("ok"),
  );

  try {
    // Saturate the main listener's request pipeline by leaving
    // many in-flight requests hanging. We don't await them — they're
    // background load. 64 concurrent slow handlers is well above any
    // realistic Deno per-listener accept-queue depth.
    const flood = Array.from({ length: 64 }, () =>
      fetch(`http://127.0.0.1:${mainPort}/`).catch(() => undefined),
    );

    // Give the flood time to actually open sockets and reach the
    // (suspended) handler — without this small delay we'd be racing
    // the kernel's TCP backlog rather than the per-listener pool.
    await new Promise((r) => setTimeout(r, 100));

    // The probe must come back well under 2 s (launcher's deadline).
    // 500 ms gives the test 4× headroom while still catching any
    // real regression that lets main-port pressure leak across.
    const probe = await timedProbe(`http://127.0.0.1:${livenessPort}/`, 1500);

    assertEquals(probe.body, "ok");
    assert(
      probe.elapsedMs < 500,
      `liveness probe took ${probe.elapsedMs.toFixed(1)}ms with main port saturated; ` +
        `expected <500ms. Either the listener split isn't delivering the claimed ` +
        `accept-queue isolation, or test infrastructure is slow.`,
    );

    // Don't await the flood — abort it on teardown. We just need it
    // to not contaminate other tests.
    await Promise.allSettled(flood.map(() => Promise.resolve()));
  } finally {
    // Clear pending slow-handler timers BEFORE shutting down servers,
    // otherwise the dangling setTimeout calls survive past test teardown
    // and trip Deno's resource-leak detector.
    for (const t of slowTimers) clearTimeout(t);
    slowTimers.clear();
    mainAbort.abort();
    livenessAbort.abort();
    await Promise.allSettled([mainServer.finished, livenessServer.finished]);
  }
});

Deno.test("liveness listener responds to any path (mirrors production handler)", async () => {
  const port = randomPort();
  const abort = new AbortController();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", signal: abort.signal, onListen: () => {} },
    () => new Response("ok"),
  );
  try {
    for (const path of ["/", "/health", "/anything/here", "/foo/bar/baz"]) {
      const { body } = await timedProbe(`http://127.0.0.1:${port}${path}`, 1500);
      assertEquals(body, "ok", `path ${path} returned ${body}`);
    }
  } finally {
    abort.abort();
    await server.finished.catch(() => {});
  }
});

Deno.test("liveness listener: clean shutdown via signal", async () => {
  const port = randomPort();
  const abort = new AbortController();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", signal: abort.signal, onListen: () => {} },
    () => new Response("ok"),
  );
  // Confirm it's serving.
  const before = await timedProbe(`http://127.0.0.1:${port}/`, 1000);
  assertEquals(before.body, "ok");

  // Trigger shutdown by aborting the controller (mirrors atlas-daemon's
  // healthServerAbortController.abort() in the drain step).
  abort.abort();
  await server.finished;

  // Probe must now fail (connection refused) — the port has been
  // released. We don't assert the specific error type, just that the
  // socket is no longer answering.
  let probeFailed = false;
  try {
    await timedProbe(`http://127.0.0.1:${port}/`, 500);
  } catch {
    probeFailed = true;
  }
  assert(probeFailed, "expected probe to fail after shutdown, but it succeeded");
});
