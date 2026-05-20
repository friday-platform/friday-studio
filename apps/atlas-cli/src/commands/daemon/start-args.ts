/**
 * Pure CLI-arg helpers extracted from `start.tsx` so unit tests can
 * import them without pulling in start.tsx's transitive imports (which
 * include `@atlas/client/v2`, daemon credential helpers, etc — heavy
 * for a test that just wants to verify a string-to-args transform).
 *
 * Two pure functions, both used by the daemon-start command:
 *
 *   - deriveHealthPort: argv → number. Default <port>+1, explicit
 *     override otherwise. Disabling is via `--health-port == --port`
 *     (the daemon's equal-port guard makes that a no-op).
 *
 *   - buildDaemonArgs: argv → string[] passed to the re-execed
 *     `friday daemon start` subprocess. Propagates --health-port when
 *     set, omits it when not.
 */

export interface StartArgs {
  port?: number;
  healthPort?: number;
  hostname?: string;
  detached?: boolean;
  logLevel?: string;
  atlasConfig?: string;
}

export function buildDaemonArgs(argv: StartArgs): string[] {
  return [
    "daemon",
    "start",
    "--port",
    (argv.port || 8080).toString(),
    ...(argv.healthPort !== undefined ? ["--health-port", argv.healthPort.toString()] : []),
    "--hostname",
    argv.hostname || "127.0.0.1",
    ...(argv.logLevel ? ["--log-level", argv.logLevel] : []),
    ...(argv.atlasConfig ? ["--atlas-config", argv.atlasConfig] : []),
  ];
}

/**
 * Resolve the daemon's liveness listener port from CLI args.
 *
 * Returns the explicit `--health-port` when set; otherwise `<port>+1`.
 * Disabling is via `--health-port <same-as---port>`, which the daemon's
 * own equal-port guard turns into a single-listener mode no-op.
 */
export function deriveHealthPort(argv: StartArgs): number {
  const mainPort = argv.port ?? 8080;
  return argv.healthPort ?? mainPort + 1;
}
