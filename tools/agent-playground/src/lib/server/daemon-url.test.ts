import { env } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { effectiveDaemonUrl } from "./daemon-url.ts";

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

describe("effectiveDaemonUrl", () => {
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
