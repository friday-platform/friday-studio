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
await daemon.start();
