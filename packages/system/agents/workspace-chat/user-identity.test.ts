import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetUser, mockSetUserIdentity, mockMarkOnboardingComplete, mockParseResult } =
  vi.hoisted(() => ({
    mockGetUser: vi.fn(),
    mockSetUserIdentity: vi.fn(),
    mockMarkOnboardingComplete: vi.fn(),
    mockParseResult: vi.fn(),
  }));

vi.mock("@atlas/core/users/storage", () => ({
  UserStorage: {
    getUser: mockGetUser,
    setUserIdentity: mockSetUserIdentity,
    markOnboardingComplete: mockMarkOnboardingComplete,
  },
  ONBOARDING_VERSION: 1,
}));

vi.mock("@atlas/client/v2", () => ({
  client: { me: { index: { $get: vi.fn() } } },
  parseResult: mockParseResult,
}));

import { fetchUserIdentitySection } from "./user-identity.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  mockGetUser.mockReset();
  mockSetUserIdentity.mockReset();
  mockMarkOnboardingComplete.mockReset();
  mockParseResult.mockReset();
  mockSetUserIdentity.mockResolvedValue({ ok: true, data: {} });
  mockMarkOnboardingComplete.mockResolvedValue({ ok: true, data: {} });
});

/**
 * The auto-sync IIFE is fire-and-forget — `void (async () => { ... })()`.
 * Tests need to wait for the microtask queue to drain so the
 * `setUserIdentity` / `markOnboardingComplete` calls land before
 * assertions. Two `await Promise.resolve()` ticks have proven enough
 * for this codebase; bump if a flake surfaces.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("fetchUserIdentitySection — auto-sync from /api/me", () => {
  it("returns formatted block when USERS has a name", async () => {
    mockGetUser.mockResolvedValueOnce({
      ok: true,
      data: { identity: { name: "Alex", email: "alex@x.com", nameStatus: "provided" } },
    });
    mockParseResult.mockResolvedValue({ ok: true, data: { user: null } });

    const result = await fetchUserIdentitySection("u1", logger);
    expect(result).toContain("Name: Alex");
    expect(result).toContain("Email: alex@x.com");
    expect(mockSetUserIdentity).not.toHaveBeenCalled();
  });

  it("returns undefined when neither USERS nor /api/me has anything", async () => {
    mockGetUser.mockResolvedValueOnce({ ok: true, data: null });
    mockParseResult.mockResolvedValue({ ok: true, data: { user: null } });

    const result = await fetchUserIdentitySection("u1", logger);
    expect(result).toBeUndefined();
  });

  it("auto-syncs when USERS record is missing but /api/me has identity", async () => {
    // Layer (b) of the gate: User record doesn't exist; /api/me
    // returns name/email — write through.
    mockGetUser.mockResolvedValueOnce({ ok: true, data: null });
    mockParseResult.mockResolvedValue({
      ok: true,
      data: { user: { display_name: "Auth Name", email: "auth@x.com" } },
    });

    await fetchUserIdentitySection("u1", logger);
    await flushMicrotasks();

    expect(mockSetUserIdentity).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ name: "Auth Name", email: "auth@x.com", nameStatus: "provided" }),
    );
    expect(mockMarkOnboardingComplete).toHaveBeenCalledWith("u1", 1);
  });

  it("auto-syncs when USERS exists with nameStatus=unknown", async () => {
    // Layer (a) of the gate: pre-existing record but no name yet —
    // legacy state where the migration didn't backfill.
    mockGetUser.mockResolvedValueOnce({ ok: true, data: { identity: { nameStatus: "unknown" } } });
    mockParseResult.mockResolvedValue({
      ok: true,
      data: { user: { display_name: "Auth Name", email: "auth@x.com" } },
    });

    await fetchUserIdentitySection("u1", logger);
    await flushMicrotasks();

    expect(mockSetUserIdentity).toHaveBeenCalled();
    expect(mockMarkOnboardingComplete).toHaveBeenCalled();
  });

  it("does NOT auto-sync when USERS already has nameStatus=provided", async () => {
    mockGetUser.mockResolvedValueOnce({
      ok: true,
      data: { identity: { name: "Alex", nameStatus: "provided" } },
    });
    mockParseResult.mockResolvedValue({
      ok: true,
      data: { user: { display_name: "Different Name", email: "x@x.com" } },
    });

    await fetchUserIdentitySection("u1", logger);
    await flushMicrotasks();

    expect(mockSetUserIdentity).not.toHaveBeenCalled();
    expect(mockMarkOnboardingComplete).not.toHaveBeenCalled();
  });

  it("does NOT auto-sync when USERS has nameStatus=declined", async () => {
    mockGetUser.mockResolvedValueOnce({ ok: true, data: { identity: { nameStatus: "declined" } } });
    mockParseResult.mockResolvedValue({
      ok: true,
      data: { user: { display_name: "Auth Name", email: "auth@x.com" } },
    });

    await fetchUserIdentitySection("u1", logger);
    await flushMicrotasks();

    // Declined is a deliberate user choice — do not override via auth.
    // Note: the current implementation auto-syncs on
    // `!userRecordExists || nameStatus === "unknown"`, so declined
    // does NOT trigger a sync. This test pins that behavior.
    expect(mockSetUserIdentity).not.toHaveBeenCalled();
  });

  it("does NOT auto-sync when /api/me has no name to write", async () => {
    mockGetUser.mockResolvedValueOnce({ ok: true, data: null });
    mockParseResult.mockResolvedValue({ ok: true, data: { user: null } });

    await fetchUserIdentitySection("u1", logger);
    await flushMicrotasks();

    expect(mockSetUserIdentity).not.toHaveBeenCalled();
  });

  it("does not throw when the auto-sync write itself fails", async () => {
    mockGetUser.mockResolvedValueOnce({ ok: true, data: null });
    mockParseResult.mockResolvedValue({
      ok: true,
      data: { user: { display_name: "Auth Name", email: "auth@x.com" } },
    });
    mockSetUserIdentity.mockResolvedValueOnce({ ok: false, error: "kv down" });

    await expect(fetchUserIdentitySection("u1", logger)).resolves.toBeDefined();
    await flushMicrotasks();
    // Mark should not run if set failed.
    expect(mockMarkOnboardingComplete).not.toHaveBeenCalled();
  });
});
