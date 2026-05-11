/**
 * Pins the v8 design decision 9 ("Unusable-credential predicate
 * semantics") invariant that the `createMCPTools` catch at
 * `fsm-engine.ts:3268-3284` depends on. That catch gates the wrap into
 * `UserConfigurationError.credentialRefreshFailed` on
 * `hasUnusableCredentialCause(error)`. If that predicate ever starts
 * returning `true` for `LinkCredentialUnavailableError`, the catch will
 * silently start wrapping transient errors and the v8 plan loses its
 * SKIPPED-vs-FAILED distinction for cron sessions.
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
