import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  UserConfigurationError,
} from "@atlas/core";
import { describe, expect, it } from "vitest";
import { classifySessionError } from "./runtime.ts";

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
