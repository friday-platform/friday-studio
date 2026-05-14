/**
 * Unit tests for `getAtlasDaemonUrl()` — the central choke point that
 * three new call sites (post-PR-#308) depend on:
 *   - packages/workspace/src/variable-interpolation.ts (`{{platform_url}}`)
 *   - packages/workspace/src/runtime.ts (`agentsServerUrl`)
 *   - scripts/clean.ts (daemon health probe)
 *
 * The resolution chain has six branches (see the doc comment on the
 * function) and a non-trivial TLS-upgrade transform on `explicit`. This
 * file is the only place those branches are tested directly. Without
 * these tests, a regression in the TLS-upgrade transform — the entire
 * premise of PR #308 — would ship undetected because the call-site tests
 * pin `FRIDAYD_URL` and only exercise the env-honoring path.
 */

import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAtlasDaemonUrl, getAtlasPlatformServerConfig } from "./utils.ts";

// The function reads several env vars; snapshot all of them per test so a
// developer who has run setup-tls.sh in their shell doesn't see flaky
// failures.
const ENV_KEYS = [
  "FRIDAYD_URL",
  "FRIDAY_DAEMON_URL",
  "FRIDAY_PORT_FRIDAY",
  "FRIDAY_TLS_CERT",
  "FRIDAY_TLS_KEY",
  "FRIDAY_ATLAS_PLATFORM_URL",
];

describe("getAtlasDaemonUrl", () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("no-env default is http://127.0.0.1:8080 (note: 127.0.0.1, not localhost)", () => {
    expect(getAtlasDaemonUrl()).toBe("http://127.0.0.1:8080");
  });

  it("FRIDAYD_URL wins over everything else", () => {
    process.env.FRIDAYD_URL = "http://example.test:9999";
    process.env.FRIDAY_DAEMON_URL = "http://wrong:1111";
    process.env.FRIDAY_PORT_FRIDAY = "2222";
    expect(getAtlasDaemonUrl()).toBe("http://example.test:9999");
  });

  it("FRIDAY_DAEMON_URL is honored as legacy alias when FRIDAYD_URL is unset", () => {
    process.env.FRIDAY_DAEMON_URL = "http://legacy.test:9999";
    expect(getAtlasDaemonUrl()).toBe("http://legacy.test:9999");
  });

  it("FRIDAY_PORT_FRIDAY overrides only the port; scheme and host stay default", () => {
    process.env.FRIDAY_PORT_FRIDAY = "18080";
    expect(getAtlasDaemonUrl()).toBe("http://127.0.0.1:18080");
  });

  describe("TLS auto-upgrade (the entire premise of PR #308)", () => {
    beforeEach(() => {
      // Both cert + key required to flip the TLS bit — half-set should NOT
      // upgrade. The runtime guards against half-configured TLS this way.
      process.env.FRIDAY_TLS_CERT = "/tmp/fake.crt";
      process.env.FRIDAY_TLS_KEY = "/tmp/fake.key";
    });

    it("upgrades explicit http://FRIDAYD_URL to https://", () => {
      process.env.FRIDAYD_URL = "http://localhost:8080";
      expect(getAtlasDaemonUrl()).toBe("https://localhost:8080");
    });

    it("upgrades explicit http://FRIDAY_DAEMON_URL legacy alias too", () => {
      process.env.FRIDAY_DAEMON_URL = "http://localhost:8080";
      expect(getAtlasDaemonUrl()).toBe("https://localhost:8080");
    });

    it("does NOT downgrade https://FRIDAYD_URL — user's explicit setting wins", () => {
      process.env.FRIDAYD_URL = "https://example.test:9999";
      expect(getAtlasDaemonUrl()).toBe("https://example.test:9999");
    });

    it("no-env default uses https:// scheme with port-override", () => {
      process.env.FRIDAY_PORT_FRIDAY = "18080";
      expect(getAtlasDaemonUrl()).toBe("https://127.0.0.1:18080");
    });

    it("no-env default uses https:// scheme without port-override", () => {
      expect(getAtlasDaemonUrl()).toBe("https://127.0.0.1:8080");
    });

    it("does NOT upgrade when only CERT is set (half-configured)", () => {
      delete process.env.FRIDAY_TLS_KEY;
      process.env.FRIDAYD_URL = "http://localhost:8080";
      expect(getAtlasDaemonUrl()).toBe("http://localhost:8080");
    });

    it("does NOT upgrade when only KEY is set (half-configured)", () => {
      delete process.env.FRIDAY_TLS_CERT;
      process.env.FRIDAYD_URL = "http://localhost:8080";
      expect(getAtlasDaemonUrl()).toBe("http://localhost:8080");
    });
  });
});

describe("getAtlasPlatformServerConfig", () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("derives /mcp URL from daemon URL by default", () => {
    expect(getAtlasPlatformServerConfig()).toEqual({
      transport: { type: "http", url: "http://127.0.0.1:8080/mcp" },
    });
  });

  it("FRIDAY_ATLAS_PLATFORM_URL overrides for shared-deployment mode", () => {
    process.env.FRIDAY_ATLAS_PLATFORM_URL = "https://platform.svc.cluster.local";
    expect(getAtlasPlatformServerConfig()).toEqual({
      transport: { type: "http", url: "https://platform.svc.cluster.local" },
    });
  });

  it("follows the TLS upgrade of the daemon URL when override unset", () => {
    process.env.FRIDAYD_URL = "http://localhost:8080";
    process.env.FRIDAY_TLS_CERT = "/tmp/fake.crt";
    process.env.FRIDAY_TLS_KEY = "/tmp/fake.key";
    expect(getAtlasPlatformServerConfig()).toEqual({
      transport: { type: "http", url: "https://localhost:8080/mcp" },
    });
  });
});
