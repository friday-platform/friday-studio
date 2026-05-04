import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
);

vi.mock("@atlas/core/users/storage", () => ({ UserStorage: { getUser: mockGetUser } }));

import { fetchUserProfileState } from "./user-profile.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  mockGetUser.mockReset();
});

describe("fetchUserProfileState (USERS-backed)", () => {
  it("returns unknown when no User record exists", async () => {
    mockGetUser.mockResolvedValueOnce({ ok: true, data: null });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "unknown" });
  });

  it("returns known when identity.nameStatus === provided", async () => {
    mockGetUser.mockResolvedValueOnce({
      ok: true,
      data: { identity: { name: "Ken", nameStatus: "provided" } },
    });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "known", name: "Ken" });
  });

  it("returns declined when identity.nameStatus === declined", async () => {
    mockGetUser.mockResolvedValueOnce({ ok: true, data: { identity: { nameStatus: "declined" } } });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "declined" });
  });

  it("returns unknown when nameStatus === unknown", async () => {
    mockGetUser.mockResolvedValueOnce({ ok: true, data: { identity: { nameStatus: "unknown" } } });
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

  it("returns unknown when nameStatus === provided but name is missing", async () => {
    // Defensive: shouldn't happen, but the read path should not synthesize
    // a known name from an empty string.
    mockGetUser.mockResolvedValueOnce({ ok: true, data: { identity: { nameStatus: "provided" } } });
    expect(await fetchUserProfileState("u1", logger)).toEqual({ status: "unknown" });
  });
});
