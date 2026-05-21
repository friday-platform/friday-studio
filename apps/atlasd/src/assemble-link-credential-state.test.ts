/**
 * Tests for `assembleLinkCredentialState` — the helper that walks a workspace's
 * credential refs, calls Link for each pinned id / provider-only ref, and folds
 * the results into the three buckets the setup-requirements derivation reads.
 *
 * Decision 3 (transient ≠ stale): only generic / network failures should be
 * masked as "previously-resolved still resolved" by re-adding the id to
 * `resolvedIds`. Non-transient Link errors (not-found, expired, refresh
 * unavailable) must leave the id OUT so the downstream derivation can surface
 * it as a `stale_id` / setup requirement.
 */

import type { WorkspaceConfig } from "@atlas/config";
import { describe, expect, test, vi } from "vitest";

const { mockFetchLinkCredential, mockResolveCredentialsByProvider } = vi.hoisted(() => ({
  mockFetchLinkCredential: vi.fn(),
  mockResolveCredentialsByProvider: vi.fn(),
}));

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  fetchLinkCredential: mockFetchLinkCredential,
  resolveCredentialsByProvider: mockResolveCredentialsByProvider,
}));

import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
} from "@atlas/core/mcp-registry/credential-resolver";
import { assembleLinkCredentialState } from "./assemble-link-credential-state.ts";

/** Build a minimal `WorkspaceConfig` with a single MCP server that pins one credential id. */
function configWithPinnedId(credentialId: string): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { name: "test" },
    tools: {
      mcp: {
        servers: {
          myserver: {
            transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] },
            env: { TOKEN: { from: "link", id: credentialId, key: "access_token" } },
          },
        },
      },
    },
  } as unknown as WorkspaceConfig;
}

describe("assembleLinkCredentialState pinned-id error routing", () => {
  test("LinkCredentialExpiredError leaves the id OUT of resolvedIds (stale bucket)", async () => {
    mockFetchLinkCredential.mockRejectedValueOnce(
      new LinkCredentialExpiredError("cred-expired", "expired_no_refresh", "token expired"),
    );

    const state = await assembleLinkCredentialState(configWithPinnedId("cred-expired"));

    expect(state.resolvedIds.has("cred-expired")).toBe(false);
  });

  test("LinkCredentialUnavailableError leaves the id OUT of resolvedIds (stale bucket)", async () => {
    mockFetchLinkCredential.mockRejectedValueOnce(
      new LinkCredentialUnavailableError({
        credentialId: "cred-unavailable",
        linkError: "refresh unavailable",
      }),
    );

    const state = await assembleLinkCredentialState(configWithPinnedId("cred-unavailable"));

    expect(state.resolvedIds.has("cred-unavailable")).toBe(false);
  });

  test("LinkCredentialNotFoundError leaves the id OUT of resolvedIds (regression)", async () => {
    mockFetchLinkCredential.mockRejectedValueOnce(new LinkCredentialNotFoundError("cred-missing"));

    const state = await assembleLinkCredentialState(configWithPinnedId("cred-missing"));

    expect(state.resolvedIds.has("cred-missing")).toBe(false);
  });

  test("transient/network errors keep the id IN resolvedIds (Decision 3)", async () => {
    mockFetchLinkCredential.mockRejectedValueOnce(new Error("network timeout"));

    const state = await assembleLinkCredentialState(configWithPinnedId("cred-transient"));

    expect(state.resolvedIds.has("cred-transient")).toBe(true);
  });
});
