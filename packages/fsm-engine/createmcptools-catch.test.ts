/**
 * Pins the invariant that the `createMCPTools` catch in fsm-engine wraps
 * `UserConfigurationError.credentialRefreshFailed` only when
 * `hasUnusableCredentialCause(error)` is true. Transient
 * `LinkCredentialUnavailableError` MUST NOT be in the unusable set —
 * otherwise the catch wraps transients and conflates them with
 * permanently-revoked credentials, losing the SKIPPED-vs-FAILED
 * distinction for cron sessions.
 *
 * The companion FAILED-routing assertion lives in
 * `packages/workspace/src/runtime.test.ts` against `classifySessionError`.
 */

import {
  hasUnusableCredentialCause,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
} from "@atlas/core";
import { describe, expect, it } from "vitest";

describe("fsm-engine createMCPTools catch — gate predicate contract", () => {
  it("LinkCredentialUnavailableError is NOT unusable (catch will rethrow unchanged)", () => {
    const error = new LinkCredentialUnavailableError({
      credentialId: "cred_transient",
      serverName: "google-gmail",
      provider: "google-gmail",
    });
    expect(hasUnusableCredentialCause(error)).toBe(false);
  });

  it("wrapped LinkCredentialUnavailableError in cause chain is still NOT unusable", () => {
    const inner = new LinkCredentialUnavailableError({
      credentialId: "cred_transient",
      serverName: "google-calendar",
    });
    const wrapper = new Error("wrapped by an upstream layer");
    wrapper.cause = inner;
    expect(hasUnusableCredentialCause(wrapper)).toBe(false);
  });

  it("LinkCredentialExpiredError IS unusable (catch wraps as credentialRefreshFailed)", () => {
    const error = new LinkCredentialExpiredError("cred_expired", "refresh_failed", "google-gmail");
    expect(hasUnusableCredentialCause(error)).toBe(true);
  });

  it("LinkCredentialNotFoundError IS unusable (catch wraps as credentialRefreshFailed)", () => {
    const error = new LinkCredentialNotFoundError("cred_deleted");
    expect(hasUnusableCredentialCause(error)).toBe(true);
  });
});
