/**
 * Bench: Leak #4 — Shared MCP child stderr accumulator never freed.
 *
 * Mirrors process-registry.ts:388-391:
 *
 *   let stderrAccumulator = "";
 *   child.stderr?.on("data", (data: Uint8Array) => {
 *     stderrAccumulator += new TextDecoder().decode(data);
 *   });
 *
 * The handler is set up during readiness polling and **never removed after
 * readiness completes**. For a chatty MCP child (uvicorn request logging is
 * the canonical case) the accumulator grows for the daemon's whole lifetime.
 * Not an FD leak — exactly one stderr pipe per child — but a steady RSS leak
 * that on multi-day uptime can run to hundreds of MB.
 *
 * The bench spawns a child that streams stderr at a fixed rate for N seconds
 * and reports parent RSS before vs after.
 *
 * Run with:  deno run -A tools/bench-fd-leaks/leak4-stderr-accumulator.ts <broken|fixed>
 */

import { spawn } from "node:child_process";

const DURATION_MS = 5_000;
const CHUNK_SIZE = 64 * 1024; // 64 KiB per write
const WRITE_INTERVAL_MS = 10; // ~6.4 MiB/s, ~32 MiB total over 5 s

function rssMiB(): number {
  return Math.round(Deno.memoryUsage().rss / (1024 * 1024));
}

/**
 * Child script: write fixed-size stderr chunks on a timer, exit cleanly when
 * the timer count is reached. Spawned by both phases.
 */
const CHILD_SCRIPT = `
const CHUNK = "x".repeat(${CHUNK_SIZE});
const totalWrites = Math.floor(${DURATION_MS} / ${WRITE_INTERVAL_MS});
let n = 0;
const t = setInterval(() => {
  process.stderr.write(CHUNK + "\\n");
  if (++n >= totalWrites) {
    clearInterval(t);
    process.exit(0);
  }
}, ${WRITE_INTERVAL_MS});
`;

/**
 * BROKEN — listener stays attached forever, accumulator grows unbounded.
 * Matches process-registry.ts:388-391 in production today.
 */
async function runBroken(): Promise<{ accLen: number; rss: number }> {
  const before = rssMiB();
  console.log(`  before: rss=${before}MiB`);

  let accumulator = "";
  const child = spawn("node", ["-e", CHILD_SCRIPT], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", (data: Uint8Array) => {
    accumulator += new TextDecoder().decode(data);
  });

  // Wait for child to exit so we measure post-stream state.
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  // Settle: give v8 a moment + force a major GC if it's exposed (the bench
  // is occasionally re-run under `deno --v8-flags=--expose-gc` for tighter
  // RSS measurements). The cast is the standard escape hatch for the
  // optional --expose-gc helper, which Deno doesn't declare on typeof
  // globalThis.
  await new Promise((r) => setTimeout(r, 500));
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc === "function") maybeGc();
  await new Promise((r) => setTimeout(r, 200));

  const after = rssMiB();
  console.log(
    `  after:  rss=${after}MiB   accumulator=${(accumulator.length / 1024 / 1024).toFixed(1)}MiB still held`,
  );
  return { accLen: accumulator.length, rss: after - before };
}

/**
 * FIXED — listener removed once the "ready" condition fires (simulated by a
 * short delay matching the production readiness probe window). After release,
 * the child's stderr is consumed but discarded; the accumulator is a small
 * bounded buffer of the bytes received BEFORE readiness, which is all the
 * production code actually needs for error diagnosis.
 */
async function runFixed(): Promise<{ accLen: number; rss: number }> {
  const before = rssMiB();
  console.log(`  before: rss=${before}MiB`);

  let accumulator = "";
  const child = spawn("node", ["-e", CHILD_SCRIPT], { stdio: ["ignore", "ignore", "pipe"] });

  // Single named handler so we can remove it later. Identical bytes-in path
  // to the BROKEN variant up until release.
  const onData = (data: Uint8Array) => {
    accumulator += new TextDecoder().decode(data);
  };
  child.stderr?.on("data", onData);

  // Simulate "readiness reached" 200 ms in — production calls this when the
  // child's HTTP probe first returns 2xx/4xx. From this point forward we
  // discard stderr (still need to consume it so the pipe buffer doesn't
  // back-pressure the child) but stop accumulating.
  await new Promise((r) => setTimeout(r, 200));
  child.stderr?.off("data", onData);
  child.stderr?.on("data", () => {}); // drain-and-discard

  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  await new Promise((r) => setTimeout(r, 500));
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc === "function") maybeGc();
  await new Promise((r) => setTimeout(r, 200));

  const after = rssMiB();
  console.log(
    `  after:  rss=${after}MiB   accumulator=${(accumulator.length / 1024 / 1024).toFixed(2)}MiB held (only pre-ready bytes)`,
  );
  return { accLen: accumulator.length, rss: after - before };
}

if (import.meta.main) {
  const pattern = Deno.args[0] ?? "both";
  console.log(`pid=${Deno.pid}; pattern=${pattern}; duration=${DURATION_MS}ms`);

  if (pattern === "broken" || pattern === "both") {
    console.log(`\n=== BROKEN (listener never removed) ===`);
    const broken = await runBroken();
    console.log(
      `\n[BROKEN] heldStr=${(broken.accLen / 1024 / 1024).toFixed(1)}MiB ΔRss=${broken.rss}MiB`,
    );
  }
  if (pattern === "fixed" || pattern === "both") {
    console.log(`\n=== FIXED (listener removed at readiness) ===`);
    const fixed = await runFixed();
    console.log(
      `\n[FIXED] heldStr=${(fixed.accLen / 1024 / 1024).toFixed(2)}MiB ΔRss=${fixed.rss}MiB`,
    );
  }
}
