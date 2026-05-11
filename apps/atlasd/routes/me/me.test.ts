import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppVariables } from "../../src/factory.ts";

const MeBodySchema = z.object({ user: z.object({ id: z.string() }).passthrough() });
const ErrorBodySchema = z.object({ error: z.string() });

// Hoisted mocks — must be declared before vi.mock calls
const mockGetCurrentUser = vi.hoisted(() => vi.fn());
const mockUpdateCurrentUser = vi.hoisted(() => vi.fn());
const mockValidatePhoto = vi.hoisted(() => vi.fn());
const mockSavePhoto = vi.hoisted(() => vi.fn());
const mockGetPhoto = vi.hoisted(() => vi.fn());
const mockDeletePhoto = vi.hoisted(() => vi.fn());
const mockUserStorage = vi.hoisted(() => ({ getUser: vi.fn(), markOnboardingComplete: vi.fn() }));

vi.mock("./adapter.ts", () => ({
  getCurrentUser: mockGetCurrentUser,
  updateCurrentUser: mockUpdateCurrentUser,
}));

vi.mock("./photo-storage.ts", () => ({
  validatePhoto: mockValidatePhoto,
  savePhoto: mockSavePhoto,
  getPhoto: mockGetPhoto,
  deletePhoto: mockDeletePhoto,
}));

vi.mock("@atlas/core/users/storage", () => ({
  UserStorage: mockUserStorage,
  ONBOARDING_VERSION: 1,
}));

// Import after mocks
import { meRoutes } from "./index.ts";

let currentUserId: string | undefined = "test-user-123";

/**
 * Tests exercise `meRoutes` directly without the session middleware
 * that normally sets `c.get("userId")`. Mount under a thin pre-middleware
 * that mirrors what `createSessionMiddleware()` would do in production,
 * with the userId swap-able for the "no identity" 503 case.
 */
const testApp = new Hono<AppVariables>()
  .use("*", async (c, next) => {
    if (currentUserId !== undefined) c.set("userId", currentUserId);
    await next();
  })
  .route("/", meRoutes);

const fakeUser = {
  id: "test-user-123",
  full_name: "Test User",
  email: "test@example.com",
  created_at: "2024-01-01T00:00:00.000000Z",
  updated_at: "2024-01-02T00:00:00.000000Z",
  display_name: "tester",
  profile_photo: null,
  usage: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  currentUserId = "test-user-123";
});

describe("GET /", () => {
  it("returns user identity", async () => {
    mockGetCurrentUser.mockResolvedValue({ ok: true, data: fakeUser });

    const res = await testApp.request("/");
    expect(res.status).toBe(200);

    const body = MeBodySchema.parse(await res.json());
    expect(body.user.id).toBe("test-user-123");
    expect(body.user.email).toBe("test@example.com");
  });

  it("returns 503 when adapter fails", async () => {
    mockGetCurrentUser.mockResolvedValue({ ok: false, error: "service down" });

    const res = await testApp.request("/");
    expect(res.status).toBe(503);
  });
});

describe("PATCH /", () => {
  it("proxies JSON field updates to adapter", async () => {
    const updatedUser = { ...fakeUser, full_name: "Updated Name" };
    mockUpdateCurrentUser.mockResolvedValue({ ok: true, data: updatedUser });

    const res = await testApp.request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: "Updated Name" }),
    });

    expect(res.status).toBe(200);
    const body = MeBodySchema.parse(await res.json());
    expect(body.user.full_name).toBe("Updated Name");
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith("test-user-123", {
      full_name: "Updated Name",
      display_name: undefined,
      profile_photo: undefined,
    });
  });

  it("handles multipart with photo file and fields", async () => {
    const updatedUser = { ...fakeUser, profile_photo: "/api/me/photo" };
    mockValidatePhoto.mockReturnValue({ valid: true, ext: ".png" });
    mockSavePhoto.mockResolvedValue(undefined);
    mockUpdateCurrentUser.mockResolvedValue({ ok: true, data: updatedUser });

    const formData = new FormData();
    formData.append("photo", new File([new Uint8Array(100)], "photo.png", { type: "image/png" }));
    formData.append("fields", JSON.stringify({ display_name: "newname" }));

    const res = await testApp.request("/", { method: "PATCH", body: formData });

    expect(res.status).toBe(200);
    expect(mockValidatePhoto).toHaveBeenCalled();
    expect(mockSavePhoto).toHaveBeenCalledWith("test-user-123", expect.any(ArrayBuffer), ".png");
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith("test-user-123", {
      full_name: undefined,
      display_name: "newname",
      profile_photo: expect.stringMatching(/^http:\/\/localhost\/api\/me\/photo\?v=\d+$/),
    });
  });

  it("rejects invalid photo", async () => {
    mockValidatePhoto.mockReturnValue({ valid: false, error: "Photo must be under 5MB" });

    const formData = new FormData();
    formData.append("photo", new File([new Uint8Array(100)], "big.png", { type: "image/png" }));

    const res = await testApp.request("/", { method: "PATCH", body: formData });

    expect(res.status).toBe(400);
    const body = ErrorBodySchema.parse(await res.json());
    expect(body.error).toBe("Photo must be under 5MB");
  });

  it("deletes photo when profile_photo is null", async () => {
    mockDeletePhoto.mockResolvedValue(undefined);
    mockUpdateCurrentUser.mockResolvedValue({
      ok: true,
      data: { ...fakeUser, profile_photo: null },
    });

    const res = await testApp.request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_photo: null }),
    });

    expect(res.status).toBe(200);
    expect(mockDeletePhoto).toHaveBeenCalledWith("test-user-123");
  });

  it("returns 400 on malformed JSON body", async () => {
    const res = await testApp.request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{",
    });

    expect(res.status).toBe(400);
    const body = ErrorBodySchema.parse(await res.json());
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 503 when adapter fails", async () => {
    mockUpdateCurrentUser.mockResolvedValue({ ok: false, error: "persona down" });

    const res = await testApp.request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: "Name" }),
    });

    expect(res.status).toBe(503);
  });
});

describe("GET /photo", () => {
  it("serves stored photo with correct content-type", async () => {
    const photoData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    mockGetPhoto.mockResolvedValue({ data: photoData, contentType: "image/png" });

    const res = await testApp.request("/photo");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body[0]).toBe(0x89);
    expect(body.length).toBe(4);
  });

  it("returns 404 when no photo exists", async () => {
    mockGetPhoto.mockResolvedValue(null);

    const res = await testApp.request("/photo");

    expect(res.status).toBe(404);
    const body = ErrorBodySchema.parse(await res.json());
    expect(body.error).toBe("No photo found");
  });

  it("returns 503 when user identity unavailable", async () => {
    currentUserId = undefined;

    const res = await testApp.request("/photo");

    expect(res.status).toBe(503);
  });
});

describe("GET /onboarding", () => {
  it("returns completed=false with empty requiredFields when the user record is unset (local mode default)", async () => {
    mockUserStorage.getUser.mockResolvedValue({ ok: true, data: null });

    const res = await testApp.request("/onboarding");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      completed: boolean;
      requiredFields: string[];
      missingRequired: string[];
    };
    expect(body.version).toBe(1);
    expect(body.completed).toBe(false);
    expect(body.requiredFields).toEqual([]);
    expect(body.missingRequired).toEqual([]);
  });

  it("returns completed=true when the user record matches the current ONBOARDING_VERSION", async () => {
    mockUserStorage.getUser.mockResolvedValue({
      ok: true,
      data: {
        userId: "test-user-123",
        identity: { nameStatus: "provided", name: "T", email: "t@example.com" },
        preferences: {},
        onboarding: { version: 1, completedAt: "2026-05-11T00:00:00.000Z" },
        createdAt: "2026-05-11T00:00:00.000Z",
        updatedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const res = await testApp.request("/onboarding");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completed: boolean };
    expect(body.completed).toBe(true);
  });

  it("returns 503 when user identity unavailable", async () => {
    currentUserId = undefined;

    const res = await testApp.request("/onboarding");
    expect(res.status).toBe(503);
  });
});

describe("POST /onboarding/complete", () => {
  it("marks onboarding complete at the current version", async () => {
    mockUserStorage.markOnboardingComplete.mockResolvedValue({
      ok: true,
      data: {
        userId: "test-user-123",
        identity: { nameStatus: "provided", name: "T" },
        preferences: {},
        onboarding: { version: 1, completedAt: "2026-05-11T00:00:00.000Z" },
        createdAt: "2026-05-11T00:00:00.000Z",
        updatedAt: "2026-05-11T00:00:00.000Z",
      },
    });

    const res = await testApp.request("/onboarding/complete", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; completed: boolean };
    expect(body.version).toBe(1);
    expect(body.completed).toBe(true);
    expect(mockUserStorage.markOnboardingComplete).toHaveBeenCalledWith("test-user-123", 1);
  });

  it("propagates 503 when the storage write fails", async () => {
    mockUserStorage.markOnboardingComplete.mockResolvedValue({ ok: false, error: "kv down" });

    const res = await testApp.request("/onboarding/complete", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("returns 503 when user identity unavailable", async () => {
    currentUserId = undefined;

    const res = await testApp.request("/onboarding/complete", { method: "POST" });
    expect(res.status).toBe(503);
  });
});

describe("PATCH / onboarding fields (email / timezone / locale)", () => {
  it("accepts and forwards the new identity fields", async () => {
    mockUpdateCurrentUser.mockResolvedValue({
      ok: true,
      data: { ...fakeUser, email: "new@example.com" },
    });

    const res = await testApp.request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "new@example.com",
        timezone: "America/New_York",
        locale: "en-US",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateCurrentUser).toHaveBeenCalledWith("test-user-123", {
      full_name: undefined,
      display_name: undefined,
      profile_photo: undefined,
      email: "new@example.com",
      timezone: "America/New_York",
      locale: "en-US",
    });
  });

  it("rejects malformed email", async () => {
    const res = await testApp.request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed locale tag", async () => {
    const res = await testApp.request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "not a locale!" }),
    });
    expect(res.status).toBe(400);
  });
});
