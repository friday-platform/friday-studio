/**
 * Bench: Leak #1 — HTTP fetch body undrained on !response.ok.
 *
 * Spins up a local HTTP server that returns 500 on every request, then hits
 * it N times under two patterns and reports the TCP socket FD count after
 * each phase:
 *
 *   broken:  await fetch(); if (!res.ok) return  // body never read
 *   fixed:   await fetch(); if (!res.ok) { await res.body?.cancel(); return }
 *
 * Run with:  deno run -A tools/bench-fd-leaks/leak1-fetch-undrained.ts
 */

const TOTAL_REQUESTS = 2_000;
const CONCURRENCY = 64;
const SETTLE_MS = 2_000;

/**
 * Body is large enough that hyper can't fit it in a single TCP segment, so a
 * non-drained body forces the socket to stay "in use" instead of being
 * returned to the keep-alive pool. Without this, hyper's fast-path on small
 * responses recycles the socket even when the consumer drops the Response.
 * 1 MiB is comfortably above any reasonable MSS / initial congestion window
 * yet small enough to keep the bench fast.
 */
const BODY = "x".repeat(1024 * 1024);

function startServer(): { url: string; close: () => Promise<void> } {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    () =>
      new Response(BODY, {
        status: 500,
        headers: { "content-type": "text/plain", "content-length": String(BODY.length) },
      }),
  );
  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

async function countOpenFds(): Promise<{ total: number; tcp: number }> {
  // macOS `lsof -p <pid>` is the cleanest cross-process view. We pipe through
  // grep to separate TCP sockets (the leak class) from all other FDs (which
  // also includes log files, the bound listener, etc).
  const pid = Deno.pid;
  const cmd = new Deno.Command("bash", {
    args: ["-c", `lsof -p ${pid} 2>/dev/null | wc -l ; lsof -p ${pid} 2>/dev/null | grep -c TCP`],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await cmd.output();
  const out = new TextDecoder().decode(stdout).trim().split("\n");
  return { total: parseInt(out[0] ?? "0", 10), tcp: parseInt(out[1] ?? "0", 10) };
}

/** The leaky pattern: fetch, throw on !ok, never drain body. */
async function brokenFetch(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) return;
  await res.text(); // unreached on 500s
}

/** The fixed pattern: cancel the body before bailing on !ok. */
async function fixedFetch(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return;
  }
  await res.text();
}

async function runPhase(label: string, fn: (url: string) => Promise<void>, url: string) {
  console.log(`\n=== ${label} ===`);
  const beforeFds = await countOpenFds();
  console.log(`  before:  total=${beforeFds.total} tcp=${beforeFds.tcp}`);

  let peakTcp = beforeFds.tcp;
  let peakTotal = beforeFds.total;
  const peakWatcher = setInterval(async () => {
    const c = await countOpenFds();
    if (c.tcp > peakTcp) peakTcp = c.tcp;
    if (c.total > peakTotal) peakTotal = c.total;
  }, 25);

  const t0 = performance.now();
  // Concurrent workers — N pulls from the queue, each fires fn and awaits it
  // before grabbing the next. Hyper's pool sees CONCURRENCY in-flight at any
  // moment, which is the shape we care about. Sequential await never stresses
  // the pool because the previous socket is always idle by the time the next
  // request fires.
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= TOTAL_REQUESTS) return;
      await fn(url);
    }
  });
  await Promise.all(workers);
  const elapsed = (performance.now() - t0).toFixed(0);
  console.log(`  in-flight: ${TOTAL_REQUESTS} req @ concurrency=${CONCURRENCY} in ${elapsed}ms`);
  console.log(`  peak:    total=${peakTotal} tcp=${peakTcp}`);

  // Force a pass through the event loop + let hyper recycle anything it can.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  clearInterval(peakWatcher);
  const afterFds = await countOpenFds();
  console.log(`  after:   total=${afterFds.total} tcp=${afterFds.tcp}`);
  console.log(
    `  Δ total=${afterFds.total - beforeFds.total} Δ tcp=${afterFds.tcp - beforeFds.tcp}`,
  );
  return { beforeFds, afterFds, peakTcp, peakTotal };
}

if (import.meta.main) {
  const pattern = Deno.args[0] ?? "both";
  const server = startServer();
  console.log(`server up at ${server.url}; pid=${Deno.pid}; pattern=${pattern}`);

  try {
    // Warm-up: prime hyper's pool, dns cache, etc. without polluting the
    // observed phase. Use a no-op handler so we don't pre-seed the leak.
    console.log(`\n--- warm-up (200 sequential reqs, draining bodies) ---`);
    for (let i = 0; i < 200; i++) await fixedFetch(server.url);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const warm = await countOpenFds();
    console.log(`  post-warm: total=${warm.total} tcp=${warm.tcp}`);

    if (pattern === "broken" || pattern === "both") {
      const broken = await runPhase("BROKEN (no body drain)", brokenFetch, server.url);
      console.log(`\n[BROKEN] peak tcp=${broken.peakTcp}  end tcp=${broken.afterFds.tcp}`);
    }
    if (pattern === "fixed" || pattern === "both") {
      if (pattern === "both") await new Promise((r) => setTimeout(r, SETTLE_MS));
      const fixed = await runPhase("FIXED (drain body)", fixedFetch, server.url);
      console.log(`\n[FIXED] peak tcp=${fixed.peakTcp}  end tcp=${fixed.afterFds.tcp}`);
    }
  } finally {
    await server.close();
  }
}
