import { describe, expect, it } from "vitest";
import { buildVarsOverride, hasMissingSecretValue, isSecretKey } from "./env-set-tool-card.ts";

describe("buildVarsOverride", () => {
  it("uses the user-typed value when present", () => {
    const out = buildVarsOverride([["API_KEY", ""]], { API_KEY: "sk-real" });
    expect(out).toEqual({ API_KEY: "sk-real" });
  });

  it("falls back to the proposed value when no user value is provided", () => {
    const out = buildVarsOverride([["API_KEY", "sk-proposed"]], {});
    expect(out).toEqual({ API_KEY: "sk-proposed" });
  });

  it("emits an empty string when neither user nor proposed has a value", () => {
    const out = buildVarsOverride([["API_KEY", ""]], {});
    expect(out).toEqual({ API_KEY: "" });
  });

  it("includes non-secret keys", () => {
    const out = buildVarsOverride([["PORT", "3000"]], { PORT: "9000" });
    expect(out).toEqual({ PORT: "9000" });
  });

  it("returns the user value for every key in a mixed payload", () => {
    const out = buildVarsOverride(
      [
        ["PORT", "3000"],
        ["API_KEY", ""],
        ["BASE_URL", "https://x"],
        ["DB_PASSWORD", ""],
      ],
      { API_KEY: "sk-real", DB_PASSWORD: "hunter2", PORT: "9000" },
    );
    expect(out).toEqual({
      PORT: "9000",
      API_KEY: "sk-real",
      BASE_URL: "https://x",
      DB_PASSWORD: "hunter2",
    });
  });

  it("returns an empty object for empty entries", () => {
    expect(buildVarsOverride([], {})).toEqual({});
  });

  it("preserves leading/trailing whitespace on the sent value", () => {
    const out = buildVarsOverride([["API_KEY", ""]], { API_KEY: "  sk-real  " });
    expect(out).toEqual({ API_KEY: "  sk-real  " });
  });

  it("preserves whitespace-only user values", () => {
    const out = buildVarsOverride([["API_KEY", ""]], { API_KEY: "   " });
    expect(out).toEqual({ API_KEY: "   " });
  });
});

describe("hasMissingSecretValue", () => {
  it("is true when a secret-looking key has no user value", () => {
    expect(hasMissingSecretValue([["API_KEY", ""]], {})).toBe(true);
  });

  it("is false once a real value lands for the secret key", () => {
    expect(hasMissingSecretValue([["API_KEY", ""]], { API_KEY: "sk-real" })).toBe(false);
  });

  it("treats whitespace-only secret values as missing", () => {
    // Whitespace passes the server's no-newline regex and would
    // commit. The trim() inside the gate is what keeps this from
    // becoming a silent blank-confirm of a credential-bearing key.
    expect(hasMissingSecretValue([["API_KEY", ""]], { API_KEY: "   " })).toBe(true);
  });

  it("ignores non-secret keys", () => {
    expect(hasMissingSecretValue([["LOG_DIR", ""]], {})).toBe(false);
  });

  it("is true if any secret key is empty in a mixed payload", () => {
    expect(
      hasMissingSecretValue(
        [
          ["LOG_DIR", "/var/log"],
          ["API_KEY", ""],
        ],
        { LOG_DIR: "/var/log" },
      ),
    ).toBe(true);
  });

  it("is false when every secret key has a real value", () => {
    expect(
      hasMissingSecretValue(
        [
          ["LOG_DIR", ""],
          ["API_KEY", ""],
          ["DB_PASSWORD", ""],
        ],
        { API_KEY: "sk-real", DB_PASSWORD: "hunter2" },
      ),
    ).toBe(false);
  });
});

describe("isSecretKey", () => {
  it.each([
    ["API_KEY", true],
    ["DB_PASSWORD", true],
    ["GITHUB_TOKEN", true],
    ["WEBHOOK_SECRET", true],
    ["AWS_CREDENTIAL", true],
    ["LOG_DIR", false],
    ["PORT", false],
    ["BASE_URL", false],
  ])("classifies %s as %s", (key, expected) => {
    expect(isSecretKey(key)).toBe(expected);
  });
});
