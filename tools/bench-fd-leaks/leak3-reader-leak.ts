/**
 * Bench: Leak #3 — Response body reader not released when read() throws.
 *
 * Mirrors the shape in packages/workspace/src/agent-executor-utils.ts:359-376:
 *   const reader = response.body?.getReader();
 *   while (true) {
 *     const { done, value } = await reader.read();   // can throw
 *     if (done) break;
 *     ...
 *   }
 *
 * If `reader.read()` rejects (server hangs up mid-stream, abort signal fires,
 * network drop) the reader is never `releaseLock`'d or `cancel`'d. The
 * underlying Response body stream stays locked, and hyper can't return the
 * socket to its pool.
 *
 * Server simulates this by accepting the connection, writing partial bytes,
 * then closing the TCP connection mid-stream so `reader.read()` rejects with
 * a network error.
 *
 * Run with:  deno run -A tools/bench-fd-leaks/leak3-reader-leak.ts <broken|fixed>
 */

const TOTAL_REQUESTS = 1_000;
const CONCURRENCY = 32;
const SETTLE_MS = 2_000;

function startServer(): { url: string; close: () => Promise<void> } {
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, () => {
    // Stream that writes a few KiB then errors out mid-body — forces the
    // CLIENT side reader.read() to reject with a TypeError / network error
    // *after* it has accepted the response and started reading.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-".repeat(1024))); // ~8 KiB
        await new Promise((r) => setTimeout(r, 5));
        controller.error(new Error("server hung up mid-body"));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  });
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

/**
 * BROKEN — current shape: no try/finally around the read loop. When
 * reader.read() throws, the reader is never released.
 */
async function brokenFetch(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    const reader = response.body?.getReader();
    if (!reader) return;
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // Expected — read() rejects on mid-stream error. Caller swallows.
  }
}

/**
 * FIXED — try/finally that always cancels the reader before re-throwing,
 * so hyper can recycle the socket.
 */
async function fixedFetch(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    const reader = response.body?.getReader();
    if (!reader) return;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      // cancel() releases the lock AND tells hyper "we're done with this
      // socket, drop whatever's left and recycle." releaseLock alone would
      // leave the body half-drained.
      await reader.cancel().catch(() => {});
    }
  } catch {
    // Same as broken — caller swallows.
  }
}

async function runPhase(label: string, fn: (url: string) => Promise<void>, url: string) {
  console.log(`\n=== ${label} ===`);
  const before = await countOpenFds();
  console.log(`  before: total=${before.total} tcp=${before.tcp}`);

  let peakTcp = before.tcp;
  let peakTotal = before.total;
  const watcher = setInterval(async () => {
    const c = await countOpenFds();
    if (c.tcp > peakTcp) peakTcp = c.tcp;
    if (c.total > peakTotal) peakTotal = c.total;
  }, 25);

  const t0 = performance.now();
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
  console.log(`  ${TOTAL_REQUESTS} req @ concurrency=${CONCURRENCY} in ${elapsed}ms`);

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  clearInterval(watcher);
  const after = await countOpenFds();
  console.log(`  peak:   total=${peakTotal} tcp=${peakTcp}`);
  console.log(`  after:  total=${after.total} tcp=${after.tcp}`);
  return { before, after, peakTcp };
}

if (import.meta.main) {
  const pattern = Deno.args[0] ?? "both";
  const server = startServer();
  console.log(`server up at ${server.url}; pid=${Deno.pid}; pattern=${pattern}`);

  try {
    if (pattern === "broken" || pattern === "both") {
      const broken = await runPhase("BROKEN (no reader cleanup)", brokenFetch, server.url);
      console.log(`\n[BROKEN] peak tcp=${broken.peakTcp}  end tcp=${broken.after.tcp}`);
    }
    if (pattern === "fixed" || pattern === "both") {
      if (pattern === "both") await new Promise((r) => setTimeout(r, SETTLE_MS));
      const fixed = await runPhase("FIXED (cancel reader in finally)", fixedFetch, server.url);
      console.log(`\n[FIXED] peak tcp=${fixed.peakTcp}  end tcp=${fixed.after.tcp}`);
    }
  } finally {
    await server.close();
  }
}
