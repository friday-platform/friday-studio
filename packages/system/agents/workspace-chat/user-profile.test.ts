import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.stubGlobal("fetch", mockFetch);
vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:3000" }));

import { fetchUserProfileState, parseUserProfileState } from "./user-profile.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  mockFetch.mockReset();
});

describe("parseUserProfileState", () => {
  it("returns unknown for empty entries", () => {
    expect(parseUserProfileState([])).toEqual({ status: "unknown" });
  });

  it("returns known with name when user-name metadata entry exists", () => {
    const entries = [{ text: "User's name is Ken", metadata: { type: "user-name" } }];
    expect(parseUserProfileState(entries)).toEqual({ status: "known", name: "Ken" });
  });

  it("returns declined when name-declined metadata entry exists", () => {
    const entries = [
      { text: "User declined to share their name", metadata: { type: "name-declined" } },
    ];
    expect(parseUserProfileState(entries)).toEqual({ status: "declined" });
  });

  it("returns known when both name and decline entries exist (name wins)", () => {
    const entries = [
      { text: "User declined to share their name", metadata: { type: "name-declined" } },
      { text: "User's name is Ken", metadata: { type: "user-name" } },
    ];
    expect(parseUserProfileState(entries)).toEqual({ status: "known", name: "Ken" });
  });

  it("returns unknown when entries have no matching metadata type", () => {
    const entries = [
      { text: "User prefers dark mode", metadata: { category: "preference" } },
      { text: "Some other note" },
    ];
    expect(parseUserProfileState(entries)).toEqual({ status: "unknown" });
  });

  it("extracts name with 'call me' pattern", () => {
    const entries = [{ text: "Call me Alice", metadata: { type: "user-name" } }];
    expect(parseUserProfileState(entries)).toEqual({ status: "known", name: "Alice" });
  });

  it("falls back to full text when regex does not match", () => {
    const entries = [{ text: "Alice", metadata: { type: "user-name" } }];
    expect(parseUserProfileState(entries)).toEqual({ status: "known", name: "Alice" });
  });
});

describe("fetchUserProfileState", () => {
  it("returns unknown when daemon returns empty array", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    const state = await fetchUserProfileState("ws-1", logger);
    expect(state).toEqual({ status: "unknown" });
  });

  it("returns known when daemon returns name entry with metadata", async () => {
    const entries = [
      {
        id: "e1",
        text: "User's name is Ken",
        createdAt: "2026-01-01T00:00:00Z",
        metadata: { type: "user-name" },
      },
    ];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(entries), { status: 200 }));
    const state = await fetchUserProfileState("ws-1", logger);
    expect(state).toEqual({ status: "known", name: "Ken" });
  });

  it("returns unknown on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    const state = await fetchUserProfileState("ws-1", logger);
    expect(state).toEqual({ status: "unknown" });
  });

  it("returns unknown on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const state = await fetchUserProfileState("ws-1", logger);
    expect(state).toEqual({ status: "unknown" });
  });
});
