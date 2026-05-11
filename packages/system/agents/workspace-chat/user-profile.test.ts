import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
);

vi.mock("@atlas/core/users/storage", () => ({
  UserStorage: { getUser: mockGetUser },
  ONBOARDING_VERSION: 1,
}));

import { fetchUserProfileState } from "./user-profile.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const completedAt = "2026-01-01T00:00:00.000Z";
const onboarded = (over?: Record<string, unknown>) => ({
  onboarding: { completedAt, version: 1 },
  ...over,
});

beforeEach(() => {
  mockGetUser.mockReset();
});

describe("fetchUserProfileState — onboarding gate", () => {
  it("returns unknown when no User record exists", async () => {
    mockGetUser.mockResolvedValueOnce({ ok: true, data: null });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "unknown" });
  });

  it("returns unknown when onboarding.completedAt is missing — even if name is set", async () => {
    // Pre-onboarding-complete users always re-onboard. This is the gate
    // the plan specifies: completedAt + version, not nameStatus alone.
    mockGetUser.mockResolvedValueOnce({
      ok: true,
      data: {
        onboarding: { version: 1 }, // no completedAt
        identity: { name: "Ken", nameStatus: "provided" },
      },
    });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "unknown" });
  });

  it("returns unknown when onboarding.version is below ONBOARDING_VERSION", async () => {
    // Version bump → re-onboard. This is the design intent (declined
    // users get re-asked when the script meaningfully changes).
    mockGetUser.mockResolvedValueOnce({
      ok: true,
      data: {
        onboarding: { completedAt, version: 0 },
        identity: { name: "Ken", nameStatus: "provided" },
      },
    });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "unknown" });
  });

  it("returns known once onboarded with provided name", async () => {
    mockGetUser.mockResolvedValueOnce({
      ok: true,
      data: onboarded({ identity: { name: "Ken", nameStatus: "provided" } }),
    });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "known", name: "Ken" });
  });

  it("returns declined once onboarded with declined nameStatus", async () => {
    mockGetUser.mockResolvedValueOnce({
      ok: true,
      data: onboarded({ identity: { nameStatus: "declined" } }),
    });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "declined" });
  });

  it("returns unknown when onboarded but nameStatus is still unknown", async () => {
    // Defensive: onboarded record but no name choice yet — shouldn't
    // happen via the normal flow (set_user_identity sets nameStatus
    // before markOnboardingComplete) but the read should not invent a
    // status.
    mockGetUser.mockResolvedValueOnce({
      ok: true,
      data: onboarded({ identity: { nameStatus: "unknown" } }),
    });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "unknown" });
  });

  it("returns unknown when nameStatus === provided but name is missing", async () => {
    mockGetUser.mockResolvedValueOnce({
      ok: true,
      data: onboarded({ identity: { nameStatus: "provided" } }),
    });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "unknown" });
  });

  it("returns unknown when UserStorage.getUser fails", async () => {
    mockGetUser.mockResolvedValueOnce({ ok: false, error: "boom" });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "unknown" });
  });

  it("returns unknown when UserStorage.getUser throws", async () => {
    mockGetUser.mockRejectedValueOnce(new Error("connection lost"));
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "unknown" });
  });
});
