/**
 * Unit tests for the pure-function pieces of `daemon start` —
 * specifically the CLI → daemon-options shape transform. These exist
 * because the daemon's full vitest harness is broken (Deno globals
 * unavailable in the vitest environment), and the most regression-
 * prone code in the daemon-start path is right here: branchy logic
 * that decides whether to spawn the liveness listener at all and
 * which port it lands on.
 *
 * Two functions, both pure:
 *
 *   - deriveHealthPort: argv → number; default <port>+1, explicit
 *     override otherwise. Disabling is via `--health-port == --port`
 *     (the daemon's equal-port guard makes that a no-op).
 *
 *   - buildDaemonArgs: argv → string[] passed to the re-execed
 *     `friday daemon start` subprocess. Must propagate --health-port
 *     when set, omit it when not.
 */

import { describe, expect, it } from "vitest";
import { buildDaemonArgs, deriveHealthPort, type StartArgs } from "./start.tsx";

describe("deriveHealthPort", () => {
  it("defaults to <port>+1 when neither flag is set", () => {
    expect(deriveHealthPort({})).toBe(8081);
  });

  it("defaults to <port>+1 when only --port is set", () => {
    expect(deriveHealthPort({ port: 9000 })).toBe(9001);
  });

  it("returns the explicit --health-port verbatim when set", () => {
    expect(deriveHealthPort({ port: 8080, healthPort: 12345 })).toBe(12345);
  });

  it("preserves --health-port even when it equals --port (daemon's own guard handles the no-op)", () => {
    // Disabling the liveness listener is via the daemon-side equal-port
    // guard, NOT a special return from this helper. Returning 8080 here
    // is correct — AtlasDaemon.startHealthListener sees healthPort ===
    // options.port and short-circuits without binding.
    expect(deriveHealthPort({ port: 8080, healthPort: 8080 })).toBe(8080);
  });

  it("returns 65536 at the 16-bit boundary; launcher must short-circuit before this", () => {
    // 65535 + 1 = 65536 is not a bindable port. The launcher's friday
    // spec handles this case by passing --health-port 65535 explicitly
    // (so the daemon's equal-port guard short-circuits without binding).
    // If we ever get called with port=65535 AND no override on
    // healthPort, the daemon will throw at bind time — the synchronous
    // try/catch in startHealthListener catches it and logs cleanly.
    expect(deriveHealthPort({ port: 65535 })).toBe(65536);
  });
});

describe("buildDaemonArgs", () => {
  it("emits --port even when argv omits it (default 8080)", () => {
    expect(buildDaemonArgs({})).toEqual([
      "daemon",
      "start",
      "--port",
      "8080",
      "--hostname",
      "127.0.0.1",
    ]);
  });

  it("omits --health-port when argv.healthPort is undefined", () => {
    const args = buildDaemonArgs({ port: 9000 });
    expect(args).not.toContain("--health-port");
  });

  it("propagates --health-port verbatim when set (positive)", () => {
    const args = buildDaemonArgs({ port: 9000, healthPort: 9001 });
    // The flag-value pair must appear AND be adjacent (yargs reads them positionally).
    const idx = args.indexOf("--health-port");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("9001");
  });

  it("propagates --health-port even when set equal to --port (daemon-side opt-out)", () => {
    // The semantic "disable the liveness listener" is owned by the
    // daemon. The CLI's job is just to faithfully relay what the user
    // asked for. So argv.healthPort === argv.port must still produce
    // an explicit --health-port arg.
    const args = buildDaemonArgs({ port: 8080, healthPort: 8080 });
    const idx = args.indexOf("--health-port");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("8080");
  });

  it("propagates --health-port even for an unusual but valid value", () => {
    const args = buildDaemonArgs({ port: 8080, healthPort: 1 });
    const idx = args.indexOf("--health-port");
    expect(args[idx + 1]).toBe("1");
  });

  it("threads other optional args through (log level, atlas-config)", () => {
    const args = buildDaemonArgs({ port: 8080, logLevel: "debug", atlasConfig: "/tmp/cfg" });
    expect(args).toContain("--log-level");
    expect(args[args.indexOf("--log-level") + 1]).toBe("debug");
    expect(args).toContain("--atlas-config");
    expect(args[args.indexOf("--atlas-config") + 1]).toBe("/tmp/cfg");
  });

  it("uses the supplied hostname when set", () => {
    const args = buildDaemonArgs({ port: 8080, hostname: "0.0.0.0" });
    expect(args[args.indexOf("--hostname") + 1]).toBe("0.0.0.0");
  });
});

describe("deriveHealthPort ↔ buildDaemonArgs round-trip", () => {
  // The CLI computes deriveHealthPort and passes the value to
  // AtlasDaemonOptions.healthPort. If the user supplied an explicit
  // value, that same value must also flow through buildDaemonArgs to
  // the re-execed subprocess (otherwise the daemon would bind one
  // port while the launcher probes another). This test pins that
  // both helpers agree on the same number.
  const cases: Array<{ argv: StartArgs; expected: number }> = [
    { argv: {}, expected: 8081 },
    { argv: { port: 9000 }, expected: 9001 },
    { argv: { port: 8080, healthPort: 12345 }, expected: 12345 },
  ];

  it.each(cases)("argv=$argv → derived=$expected", ({ argv, expected }) => {
    const derived = deriveHealthPort(argv);
    expect(derived).toBe(expected);
    // When the user supplied an explicit value, buildDaemonArgs must
    // re-emit the same number. (When they didn't, daemon's own default
    // covers it — buildDaemonArgs omits the flag entirely.)
    if (argv.healthPort !== undefined) {
      const args = buildDaemonArgs(argv);
      const idx = args.indexOf("--health-port");
      expect(args[idx + 1]).toBe(String(derived));
    }
  });
});
