import { env } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { effectiveDaemonUrl } from "./daemon-url.ts";

// Mirrors the declaration in `daemon-url.ts`. Vite's `define` substitutes
// this at transform time when the SvelteKit Vite plugin loads the package
// config; otherwise it stays `undefined`.
declare const __FRIDAY_DAEMON_BASE_URL__: string | undefined;

// `effectiveDaemonUrl` has two branches: Vite's compile-time `define` of
// `__FRIDAY_DAEMON_BASE_URL__` (taken in dev when the SvelteKit Vite plugin
// is loaded) and the runtime-env fallback (taken in the compiled binary).
// When these tests run via `npx vitest` inside the package, the package's
// `vite.config.ts` is the resolved config, so the define is set and the
// env branch is unreachable. Skip the env-branch assertions in that case;
// `deno task test` from the repo root uses the root vitest config which
// does NOT load the package's Vite define, so the suite is meaningful
// there.
const HAS_VITE_DEFINE = typeof __FRIDAY_DAEMON_BASE_URL__ !== "undefined";

const originalEnv = {
  FRIDAYD_URL: env.FRIDAYD_URL,
  FRIDAY_TLS_CERT: env.FRIDAY_TLS_CERT,
  FRIDAY_TLS_KEY: env.FRIDAY_TLS_KEY,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

describe.skipIf(HAS_VITE_DEFINE)("effectiveDaemonUrl", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("defaults to the cleartext daemon URL", () => {
    delete env.FRIDAYD_URL;
    delete env.FRIDAY_TLS_CERT;
    delete env.FRIDAY_TLS_KEY;

    expect(effectiveDaemonUrl()).toBe("http://localhost:8080");
  });

  it("defaults to https when the s2s TLS env is present", () => {
    delete env.FRIDAYD_URL;
    env.FRIDAY_TLS_CERT = "/tmp/cert.pem";
    env.FRIDAY_TLS_KEY = "/tmp/key.pem";

    expect(effectiveDaemonUrl()).toBe("https://localhost:8080");
  });

  it("honors an explicit FRIDAYD_URL", () => {
    env.FRIDAYD_URL = "https://daemon.local:18080";
    env.FRIDAY_TLS_CERT = "/tmp/cert.pem";
    env.FRIDAY_TLS_KEY = "/tmp/key.pem";

    expect(effectiveDaemonUrl()).toBe("https://daemon.local:18080");
  });
});
