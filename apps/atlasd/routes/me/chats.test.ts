/**
 * Coverage for the cross-workspace chat listing endpoint added for the
 * @-mention autocomplete (friday-studio-c7j). Verifies the workspace
 * merge + sort + filter behavior in isolation from a live NATS by
 * mocking ChatStorage and the workspace-authz helper.
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVariables } from "../../src/factory.ts";

const mockListChatsByWorkspace = vi.hoisted(() => vi.fn());
const mockGetAccessibleWorkspaceIds = vi.hoisted(() => vi.fn());

vi.mock("@atlas/core/chat/storage", () => ({
  ChatStorage: { listChatsByWorkspace: mockListChatsByWorkspace },
}));
vi.mock("../../src/workspace-authz.ts", () => ({
  getAccessibleWorkspaceIds: mockGetAccessibleWorkspaceIds,
}));
// The me module also depends on these — stub with no-op shapes so the
// rest of meRoutes loads, even though the /chats route never touches
// them.
vi.mock("./adapter.ts", () => ({ getCurrentUser: vi.fn(), updateCurrentUser: vi.fn() }));
vi.mock("./photo-storage.ts", () => ({
  validatePhoto: vi.fn(),
  savePhoto: vi.fn(),
  getPhoto: vi.fn(),
  deletePhoto: vi.fn(),
}));
vi.mock("@atlas/core/users/storage", () => ({
  UserStorage: { getUser: vi.fn(), markOnboardingComplete: vi.fn() },
  ONBOARDING_VERSION: 1,
}));

import { meRoutes } from "./index.ts";

let currentUserId: string | undefined = "user-1";

const testApp = new Hono<AppVariables>()
  .use("*", async (c, next) => {
    if (currentUserId !== undefined) c.set("userId", currentUserId);
    await next();
  })
  .route("/", meRoutes);

function chat(workspaceId: string, id: string, title: string, updatedAt: string) {
  return {
    ok: true,
    data: {
      chats: [
        { id, workspaceId, title, userId: "u", source: "atlas", createdAt: updatedAt, updatedAt },
      ],
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  currentUserId = "user-1";
  vi.stubEnv("FRIDAY_ENV", "dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /chats", () => {
  it("merges chats across every accessible workspace, sorted by updatedAt DESC", async () => {
    mockGetAccessibleWorkspaceIds.mockResolvedValue(new Set(["ws-a", "ws-b"]));
    mockListChatsByWorkspace.mockImplementation((workspaceId: string) => {
      if (workspaceId === "ws-a") return chat("ws-a", "c-old", "Old", "2026-05-01T00:00:00Z");
      return chat("ws-b", "c-new", "New", "2026-05-21T00:00:00Z");
    });

    const res = await testApp.request("/chats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chats: Array<{ workspaceId: string; chatId: string; title: string }>;
    };
    expect(body.chats.map((c) => c.chatId)).toEqual(["c-new", "c-old"]);
    expect(body.chats[0]?.workspaceId).toBe("ws-b");
  });

  it("returns an empty list when the user has no accessible workspaces", async () => {
    mockGetAccessibleWorkspaceIds.mockResolvedValue(new Set());

    const res = await testApp.request("/chats");
    const body = (await res.json()) as { chats: unknown[] };
    expect(body.chats).toEqual([]);
    expect(mockListChatsByWorkspace).not.toHaveBeenCalled();
  });

  it("filters by case-insensitive title substring via ?q=", async () => {
    mockGetAccessibleWorkspaceIds.mockResolvedValue(new Set(["ws-a"]));
    mockListChatsByWorkspace.mockResolvedValue({
      ok: true,
      data: {
        chats: [
          {
            id: "c1",
            workspaceId: "ws-a",
            title: "Demo research",
            userId: "u",
            source: "atlas",
            createdAt: "2026-05-01T00:00:00Z",
            updatedAt: "2026-05-01T00:00:00Z",
          },
          {
            id: "c2",
            workspaceId: "ws-a",
            title: "Sprint planning",
            userId: "u",
            source: "atlas",
            createdAt: "2026-05-02T00:00:00Z",
            updatedAt: "2026-05-02T00:00:00Z",
          },
        ],
      },
    });

    const res = await testApp.request("/chats?q=DEMO");
    const body = (await res.json()) as { chats: Array<{ chatId: string }> };
    expect(body.chats.map((c) => c.chatId)).toEqual(["c1"]);
  });

  it("caps the result size at the limit (default 50, hard cap 200)", async () => {
    mockGetAccessibleWorkspaceIds.mockResolvedValue(new Set(["ws-a"]));
    mockListChatsByWorkspace.mockResolvedValue({
      ok: true,
      data: {
        chats: Array.from({ length: 100 }, (_, i) => ({
          id: `c${i}`,
          workspaceId: "ws-a",
          title: `Chat ${i}`,
          userId: "u",
          source: "atlas",
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: `2026-05-01T00:00:${String(i).padStart(2, "0")}Z`,
        })),
      },
    });

    const res = await testApp.request("/chats?limit=10");
    const body = (await res.json()) as { chats: unknown[] };
    expect(body.chats).toHaveLength(10);
  });

  it("returns 401 when no session userId is set", async () => {
    currentUserId = undefined;
    const res = await testApp.request("/chats");
    expect(res.status).toBe(401);
  });

  it("filters the kernel workspace out of the autocomplete data source (friday-studio-svv)", async () => {
    // Even when the caller has kernel membership, the autocomplete must
    // not surface kernel chats — the composer has no context flag.
    mockGetAccessibleWorkspaceIds.mockResolvedValue(new Set(["system", "ws-a"]));
    mockListChatsByWorkspace.mockImplementation((workspaceId: string) => {
      if (workspaceId === "system")
        return chat("system", "k1", "Kernel internal", "2026-05-22T00:00:00Z");
      return chat("ws-a", "c1", "Demo", "2026-05-21T00:00:00Z");
    });

    const res = await testApp.request("/chats");
    const body = (await res.json()) as { chats: Array<{ workspaceId: string }> };
    expect(body.chats.every((c) => c.workspaceId !== "system")).toBe(true);
    // listChatsByWorkspace should NOT have been invoked for the kernel ws.
    const visited = mockListChatsByWorkspace.mock.calls.map((c) => c[0]);
    expect(visited).not.toContain("system");
  });
});
