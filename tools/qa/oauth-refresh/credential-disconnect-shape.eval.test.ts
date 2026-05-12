/**
 * Eval B — Transient state reaches `disconnected[]` with the right
 * shape.
 *
 * `buildDisconnectedEntry` is the conversion point between Link's typed
 * errors and the wire shape the chat layer reads. The eval pins:
 *
 *   - `LinkCredentialUnavailableError` → `kind:
 *     "credential_temporarily_unavailable"` (the transient kind the chat
 *     uses to pick the "try again in a moment" copy).
 *   - `LinkCredentialExpiredError`, `LinkCredentialNotFoundError`,
 *     `NoDefaultCredentialError` → kinds OTHER than
 *     `credential_temporarily_unavailable` (so chat doesn't render
 *     transient copy for a permanently-dead credential).
 *
 * The kind string is the wire-format invariant — if it drifts, the chat
 * chip silently picks the wrong branch.
 */

import type { MCPServerConfig } from "@atlas/config";
import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
  NoDefaultCredentialError,
} from "@atlas/core/mcp-registry/credential-resolver";
import { describe, expect, it } from "vitest";
import { buildDisconnectedEntry } from "../../../packages/mcp/src/create-mcp-tools.ts";

const config: MCPServerConfig = {
  transport: { type: "http", url: "http://example.test/mcp" },
  auth: { type: "bearer", token_env: "GOOGLE_CALENDAR_ACCESS_TOKEN" },
  env: {
    GOOGLE_CALENDAR_ACCESS_TOKEN: {
      from: "link",
      provider: "google-calendar",
      key: "access_token",
    },
  },
};

describe("oauth-refresh eval B — disconnect entry shape", () => {
  it("LinkCredentialUnavailableError → kind: credential_temporarily_unavailable", () => {
    const err = new LinkCredentialUnavailableError({
      credentialId: "cred-1",
      serverName: "google-calendar",
    });
    const entry = buildDisconnectedEntry(err, "google-calendar", config);
    expect(entry.kind).toBe("credential_temporarily_unavailable");
    expect(entry.serverId).toBe("google-calendar");
    expect(entry.provider).toBe("google-calendar");
    expect(entry.message).toMatch(/temporarily unavailable/i);
  });

  it("LinkCredentialNotFoundError → kind: credential_not_found (NOT transient)", () => {
    const err = new LinkCredentialNotFoundError("cred-2");
    const entry = buildDisconnectedEntry(err, "google-calendar", config);
    expect(entry.kind).not.toBe("credential_temporarily_unavailable");
    expect(entry.kind).toBe("credential_not_found");
  });

  it("LinkCredentialExpiredError (refresh_failed) → kind: credential_refresh_failed (NOT transient)", () => {
    const err = new LinkCredentialExpiredError("cred-3", "refresh_failed");
    const entry = buildDisconnectedEntry(err, "google-calendar", config);
    expect(entry.kind).not.toBe("credential_temporarily_unavailable");
    expect(entry.kind).toBe("credential_refresh_failed");
  });

  it("NoDefaultCredentialError → kind: no_default_credential (NOT transient)", () => {
    const err = new NoDefaultCredentialError("google-calendar");
    const entry = buildDisconnectedEntry(err, "google-calendar", config);
    expect(entry.kind).not.toBe("credential_temporarily_unavailable");
    expect(entry.kind).toBe("no_default_credential");
  });
});
