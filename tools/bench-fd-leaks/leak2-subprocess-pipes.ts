/**
 * Bench: Leak #2 — subprocess spawned with stdio:"pipe" but no on("exit")
 * listener and no stdout consumer. Mirrors apps/atlasd/routes/agents/register.ts.
 *
 * Each spawn:
 *   - Opens 3 pipe FDs (stdin/stdout/stderr) in the parent.
 *   - Without an "exit" listener, Node holds the ChildProcess reference until
 *     GC visits it; the pipe FDs stay open in the parent's table during that
 *     window.
 *   - Without a stdout consumer, the child can block on its first stdout
 *     write past ~64 KiB. Doesn't directly leak FDs but pins them open for
 *     longer.
 *
 * Run with:  deno run -A tools/bench-fd-leaks/leak2-subprocess-pipes.ts <broken|fixed>
 */

import { spawn } from "node:child_process";

const ITERATIONS = 200;
const SETTLE_MS = 2_000;

async function countOpenFds(): Promise<{ total: number; pipe: number }> {
  const pid = Deno.pid;
  const cmd = new Deno.Command("bash", {
    args: ["-c", `lsof -p ${pid} 2>/dev/null | wc -l ; lsof -p ${pid} 2>/dev/null | grep -c PIPE`],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await cmd.output();
  const out = new TextDecoder().decode(stdout).trim().split("\n");
  return { total: parseInt(out[0] ?? "0", 10), pipe: parseInt(out[1] ?? "0", 10) };
}

/**
 * Test agent: writes a small "hello" to stdout, prints to stderr, then exits
 * cleanly. Mimics what `friday-agent-sdk` does during a validate handshake.
 */
const AGENT_SCRIPT = `
console.error("starting");
console.log("hello");
console.error("done");
process.exit(0);
`;

/**
 * BROKEN — matches the current shape of apps/atlasd/routes/agents/register.ts:
 *   - stdio: "pipe" (all 3 streams)
 *   - stderr listener attached
 *   - NO stdout listener
 *   - NO on("exit") listener
 *   - SIGTERM is fire-and-forget
 */
function spawnBroken(): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("node", ["-e", AGENT_SCRIPT], { stdio: "pipe" });
    proc.stderr?.on("data", () => {});
    // Resolve immediately to simulate the original code returning after
    // metadata arrived over NATS — we don't wait for exit.
    setTimeout(() => {
      proc.kill("SIGTERM");
      resolve();
    }, 50);
  });
}

/**
 * FIXED — the shape we're moving register.ts to:
 *   - stdio: ["ignore", "ignore", "pipe"]  → only stderr is piped (1 FD)
 *   - on("exit") awaited before resolving
 */
function spawnFixed(): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("node", ["-e", AGENT_SCRIPT], { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr?.on("data", () => {});
    setTimeout(() => {
      proc.kill("SIGTERM");
    }, 50);
    proc.once("exit", () => resolve());
  });
}

async function runPhase(label: string, fn: () => Promise<void>) {
  console.log(`\n=== ${label} ===`);
  const before = await countOpenFds();
  console.log(`  before: total=${before.total} pipe=${before.pipe}`);

  let peakPipe = before.pipe;
  let peakTotal = before.total;
  const watcher = setInterval(async () => {
    const c = await countOpenFds();
    if (c.pipe > peakPipe) peakPipe = c.pipe;
    if (c.total > peakTotal) peakTotal = c.total;
  }, 25);

  const t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    await fn();
  }
  const elapsed = (performance.now() - t0).toFixed(0);
  console.log(`  ${ITERATIONS} spawns in ${elapsed}ms`);

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  clearInterval(watcher);
  const after = await countOpenFds();
  console.log(`  peak:   total=${peakTotal} pipe=${peakPipe}`);
  console.log(`  after:  total=${after.total} pipe=${after.pipe}`);
  console.log(`  Δ total=${after.total - before.total} Δ pipe=${after.pipe - before.pipe}`);
  return { before, after, peakPipe, peakTotal };
}

if (import.meta.main) {
  const pattern = Deno.args[0] ?? "both";
  console.log(`pid=${Deno.pid}; pattern=${pattern}`);

  if (pattern === "broken" || pattern === "both") {
    const broken = await runPhase("BROKEN (stdio:pipe, no on-exit)", spawnBroken);
    console.log(`\n[BROKEN] peak pipe=${broken.peakPipe} end pipe=${broken.after.pipe}`);
  }
  if (pattern === "fixed" || pattern === "both") {
    if (pattern === "both") await new Promise((r) => setTimeout(r, SETTLE_MS));
    const fixed = await runPhase("FIXED (stdio:ignore stdout, await exit)", spawnFixed);
    console.log(`\n[FIXED] peak pipe=${fixed.peakPipe} end pipe=${fixed.after.pipe}`);
  }
}
