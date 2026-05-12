import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
  UserConfigurationError,
} from "@atlas/core";
import { describe, expect, it } from "vitest";
import { WORKSPACE_DIRECT_CHAT_SIGNAL_TYPE } from "./constants.ts";
import { classifySessionError, computeSessionInteractive } from "./runtime.ts";

describe("classifySessionError", () => {
  const wrappedCredentialError = (() => {
    const inner = new LinkCredentialNotFoundError("cred_wrapped");
    const wrapper = new Error("some wrapper");
    wrapper.cause = inner;
    return wrapper;
  })();

  it.each([
    {
      name: "UserConfigurationError.missingConfiguration",
      error: UserConfigurationError.missingConfiguration(
        "test-agent",
        "test-workspace",
        ["google-calendar"],
        [],
      ),
      expected: "skipped",
    },
    {
      name: "UserConfigurationError.credentialRefreshFailed",
      error: UserConfigurationError.credentialRefreshFailed("test-agent", "github"),
      expected: "skipped",
    },
    {
      name: "LinkCredentialNotFoundError",
      error: new LinkCredentialNotFoundError("cred_deleted"),
      expected: "skipped",
    },
    {
      name: "LinkCredentialExpiredError (expired_no_refresh)",
      error: new LinkCredentialExpiredError("cred_expired", "expired_no_refresh"),
      expected: "skipped",
    },
    {
      name: "LinkCredentialExpiredError (refresh_failed)",
      error: new LinkCredentialExpiredError("cred_refresh_fail", "refresh_failed"),
      expected: "skipped",
    },
    {
      name: "wrapped credential error in cause chain",
      error: wrappedCredentialError,
      expected: "skipped",
    },
    {
      // Transient unavailable is NOT in the unusable set, so cron sessions
      // surface as FAILED (alertable platform failure) rather than SKIPPED
      // (user reconnect needed).
      name: "LinkCredentialUnavailableError",
      error: new LinkCredentialUnavailableError({
        credentialId: "cred_unavailable",
        serverName: "google-gmail",
      }),
      expected: "failed",
    },
    {
      name: "wrapped LinkCredentialUnavailableError in cause chain",
      error: (() => {
        const inner = new LinkCredentialUnavailableError({
          credentialId: "cred_unavailable",
          serverName: "google-calendar",
        });
        const wrapper = new Error("wrapper around transient");
        wrapper.cause = inner;
        return wrapper;
      })(),
      expected: "failed",
    },
    { name: "generic Error", error: new Error("Something went wrong"), expected: "failed" },
    {
      name: "TypeError",
      error: new TypeError("Cannot read property of undefined"),
      expected: "failed",
    },
    { name: "string error", error: "string error", expected: "failed" },
    { name: "null", error: null, expected: "failed" },
    { name: "undefined", error: undefined, expected: "failed" },
  ])("$name → $expected", ({ error, expected }) => {
    expect(classifySessionError(error)).toEqual(expected);
  });
});

describe("computeSessionInteractive", () => {
  it("direct-chat session is interactive regardless of provenance fallback", () => {
    // Auto-injected chat signal has no entry in workspace.signals, so the
    // provenance derivation falls back to "external". The signal-type check
    // must override that — sessions for `chat` are always interactive.
    expect(
      computeSessionInteractive({
        signalType: WORKSPACE_DIRECT_CHAT_SIGNAL_TYPE,
        signalProvenance: "external",
      }),
    ).toBe(true);
  });

  it("schedule-triggered session is non-interactive (system-config provenance)", () => {
    expect(
      computeSessionInteractive({ signalType: "daily-rollup", signalProvenance: "system-config" }),
    ).toBe(false);
  });

  it("Slack-triggered session is interactive (user-authored provenance)", () => {
    expect(
      computeSessionInteractive({ signalType: "slack-message", signalProvenance: "user-authored" }),
    ).toBe(true);
  });

  it("HTTP webhook session is non-interactive (external provenance)", () => {
    expect(
      computeSessionInteractive({ signalType: "github-webhook", signalProvenance: "external" }),
    ).toBe(false);
  });
});
