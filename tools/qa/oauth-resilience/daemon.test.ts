import { describe, expect, it } from "vitest";
import { buildDaemonEnv, DEFAULT_ELICITATION_TTL_MS } from "./daemon-env.ts";

describe("buildDaemonEnv", () => {
  it("composes the OAuth mock URIs from mockBaseUrl", () => {
    const env = buildDaemonEnv({ mockBaseUrl: "http://127.0.0.1:5050" });
    expect(env.FRIDAY_OAUTH_MOCK_EXCHANGE_URI).toEqual("http://127.0.0.1:5050");
    expect(env.FRIDAY_OAUTH_MOCK_REFRESH_URI).toEqual("http://127.0.0.1:5050/refreshToken");
  });

  it("turns on Link dev mode", () => {
    const env = buildDaemonEnv({ mockBaseUrl: "http://127.0.0.1:5050" });
    expect(env.LINK_DEV_MODE).toEqual("true");
  });

  it("defaults FRIDAY_ELICITATION_TTL_MS_OVERRIDE to 10s", () => {
    const env = buildDaemonEnv({ mockBaseUrl: "http://127.0.0.1:5050" });
    expect(env.FRIDAY_ELICITATION_TTL_MS_OVERRIDE).toEqual(String(DEFAULT_ELICITATION_TTL_MS));
  });

  it("respects an explicit elicitationTtlMs", () => {
    const env = buildDaemonEnv({ mockBaseUrl: "http://127.0.0.1:5050", elicitationTtlMs: 250 });
    expect(env.FRIDAY_ELICITATION_TTL_MS_OVERRIDE).toEqual("250");
  });

  it("elicitationTtlMs:null omits the override entirely", () => {
    const env = buildDaemonEnv({ mockBaseUrl: "http://127.0.0.1:5050", elicitationTtlMs: null });
    expect(env.FRIDAY_ELICITATION_TTL_MS_OVERRIDE).toBeUndefined();
  });

  it("extraEnv overrides defaults", () => {
    const env = buildDaemonEnv({
      mockBaseUrl: "http://127.0.0.1:5050",
      extraEnv: { LINK_DEV_MODE: "false", CUSTOM_FLAG: "yes" },
    });
    expect(env.LINK_DEV_MODE).toEqual("false");
    expect(env.CUSTOM_FLAG).toEqual("yes");
  });
});
