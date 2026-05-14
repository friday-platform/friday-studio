import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVariables } from "../src/factory.ts";

type TestMembership = { userId: string; wsId: string; role: "owner"; addedAt: string };

type TestMembershipResult = { ok: true; data: TestMembership | null };

const membershipGet = vi.hoisted(() =>
  vi.fn(
    (userId: string, wsId: string): Promise<TestMembershipResult> =>
      Promise.resolve({
        ok: true,
        data: { userId, wsId, role: "owner" as const, addedAt: "2026-05-14T00:00:00.000Z" },
      }),
  ),
);

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: {
    get: membershipGet,
    listByUser: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

import process from "node:process";
import { chatUploadsRoot } from "@atlas/utils/paths.server";
import { scratchUploadApp } from "./scratch-upload.ts";

const app = new Hono<AppVariables>()
  .use("*", async (c, next) => {
    c.set("userId", "test-user");
    await next();
  })
  .route("/", scratchUploadApp);

const originalHome = process.env.FRIDAY_HOME;
let tempHome: string;

beforeAll(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "scratch-upload-test-"));
  process.env.FRIDAY_HOME = tempHome;
});

beforeEach(() => {
  membershipGet.mockImplementation((userId: string, wsId: string) =>
    Promise.resolve({
      ok: true,
      data: { userId, wsId, role: "owner" as const, addedAt: "2026-05-14T00:00:00.000Z" },
    }),
  );
  membershipGet.mockClear();
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
  await rm(tempHome, { recursive: true, force: true });
});

function uploadForm(name: string, content: string, type = "text/plain"): FormData {
  const form = new FormData();
  form.set("file", new File([content], name, { type }));
  return form;
}

describe("POST /api/scratch/upload", () => {
  it("rejects oversized Content-Length before auth or multipart parsing", async () => {
    const res = await app.request("/upload?workspaceId=ws-a&chatId=chat-a", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        "content-length": String(26 * 1024 * 1024),
      },
      body: "",
    });

    expect(res.status).toBe(413);
    expect(membershipGet).not.toHaveBeenCalled();
  });

  it("checks workspace membership before parsing the multipart body", async () => {
    membershipGet.mockResolvedValueOnce({ ok: true, data: null });

    const res = await app.request("/upload?workspaceId=ws-denied&chatId=chat-a", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: "not actually multipart",
    });

    expect(res.status).toBe(403);
    expect(membershipGet).toHaveBeenCalledWith("test-user", "ws-denied");
  });

  it("rejects path-shaped scope ids before auth or multipart parsing", async () => {
    const res = await app.request("/upload?workspaceId=ws-a&chatId=.", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: "not actually multipart",
    });

    expect(res.status).toBe(400);
    expect(membershipGet).not.toHaveBeenCalled();
  });

  it("writes identical chat ids into separate workspace-scoped upload roots", async () => {
    const chatId = "chat-shared-id";
    const formA = uploadForm("notes.txt", "workspace A");
    const formB = uploadForm("notes.txt", "workspace B");

    const [resA, resB] = await Promise.all([
      app.request(`/upload?workspaceId=ws-a&chatId=${chatId}`, { method: "POST", body: formA }),
      app.request(`/upload?workspaceId=ws-b&chatId=${chatId}`, { method: "POST", body: formB }),
    ]);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const bodyA = (await resA.json()) as { path: string; mediaType: string };
    const bodyB = (await resB.json()) as { path: string; mediaType: string };

    expect(bodyA.path.startsWith(`${chatUploadsRoot("ws-a", chatId)}/`)).toBe(true);
    expect(bodyB.path.startsWith(`${chatUploadsRoot("ws-b", chatId)}/`)).toBe(true);
    expect(bodyA.path).not.toBe(bodyB.path);
    expect(await readFile(bodyA.path, "utf8")).toBe("workspace A");
    expect(await readFile(bodyB.path, "utf8")).toBe("workspace B");
  });

  it("rejects SVG uploads without writing a scratch file", async () => {
    const chatId = "chat-svg";
    const res = await app.request(`/upload?workspaceId=ws-a&chatId=${chatId}`, {
      method: "POST",
      body: uploadForm("payload.svg", "<svg></svg>", "image/svg+xml"),
    });

    expect(res.status).toBe(415);
    await expect(access(chatUploadsRoot("ws-a", chatId))).rejects.toThrow();
  });
});
