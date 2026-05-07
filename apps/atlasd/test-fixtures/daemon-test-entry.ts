/**
 * Subprocess entry point for daemon shutdown integration tests.
 *
 * Tests that need to verify real `Deno.exit` semantics (e.g.
 * `daemon-shutdown.test.ts`) cannot import `AtlasDaemon` into the vitest
 * process — vitest itself would die on `Deno.exit`. This file is the
 * thinnest possible bringup: construct, start, block. No CLI flags, no
 * yargs, no OTEL re-exec path. The spawned test reads stdout/stderr to
 * detect readiness and observe shutdown logs.
 *
 * Spawn from a test as:
 *   new Deno.Command(Deno.execPath(), {
 *     args: ["run", "--allow-all", "--unstable-kv",
 *            "--unstable-broadcast-channel", "--unstable-worker-options",
 *            "--unstable-raw-imports",
 *            "apps/atlasd/test-fixtures/daemon-test-entry.ts"],
 *     env: { ANTHROPIC_API_KEY: "test-key", ... },
 *     stdout: "piped", stderr: "piped",
 *   })
 */

import { AtlasDaemon } from "../src/atlas-daemon.ts";

const daemon = new AtlasDaemon({ port: 0, hostname: "127.0.0.1" });

// Test-only wedge for the watchdog negative-case test in
// `daemon-shutdown.test.ts`. When `ATLAS_TEST_WEDGE_SHUTDOWN=1`, replace
// `daemon.shutdown` with a never-resolving promise so the HTTP `/shutdown`
// route's watchdog has to fire to force exit. Pair with
// `ATLAS_SHUTDOWN_WATCHDOG_MS` (read by `routes/daemon.ts`) to keep the
// test fast.
//
// Patched BEFORE start() because start() registers SIGINT/SIGTERM handlers
// that capture `this.shutdown` via a method reference — patching after
// start would leave those handlers wired to the original method.
if (Deno.env.get("ATLAS_TEST_WEDGE_SHUTDOWN") === "1") {
  Deno.stderr.writeSync(
    new TextEncoder().encode("[test-fixture] WEDGE: replacing daemon.shutdown with hang\n"),
  );
  daemon.shutdown = () => new Promise<void>(() => {});
}

await daemon.start();
