/**
 * Cross-user denial test for the workspace-membership authz helpers.
 *
 * Drives a real NATS-backed WORKSPACE_MEMBERS bucket — `requireWorkspace*`
 * are read-from-storage calls, so the test value is end-to-end:
 *   - stamp user A as owner of ws-alpha
 *   - exercise the helper as user A on ws-alpha → resolves
 *   - exercise as user B on ws-alpha → throws HTTPException(403)
 *   - exercise as user A on ws-beta (no row) → throws HTTPException(403)
 *
 * The route-level tests mock `WorkspaceMemberStorage`; this test uses
 * the real adapter so the helper-to-bucket contract is exercised
 * once and the route-level mocks don't drift unnoticed.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import {
  ensureWorkspaceMembersKVBucket,
  initWorkspaceMemberStorage,
  resetWorkspaceMemberStorageForTests,
  WorkspaceMemberStorage,
} from "@atlas/core/workspace-members/storage";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getAccessibleWorkspaceIds,
  requireWorkspaceAdmin,
  requireWorkspaceMember,
} from "./workspace-authz.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initWorkspaceMemberStorage(nc);
  await ensureWorkspaceMembersKVBucket(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
  resetWorkspaceMemberStorageForTests();
});

const uid = () => `u_${crypto.randomUUID().slice(0, 8)}`;
const w = () => `w_${crypto.randomUUID().slice(0, 8)}`;

/** Build a minimal Hono context with userId set. */
async function ctxFor(
  userId: string | undefined,
): Promise<Parameters<typeof requireWorkspaceMember>[0]> {
  const app = new Hono();
  let captured: Parameters<typeof requireWorkspaceMember>[0] | undefined;
  app.get("/probe", (c) => {
    if (userId !== undefined) c.set("userId" as never, userId as never);
    captured = c as Parameters<typeof requireWorkspaceMember>[0];
    return c.text("");
  });
  await app.request("/probe");
  if (!captured) throw new Error("ctxFor: handler never ran");
  return captured;
}

async function grant(
  userId: string,
  wsId: string,
  role: "owner" | "admin" | "member" | "agent",
): Promise<void> {
  const r = await WorkspaceMemberStorage.put({
    userId,
    wsId,
    role,
    addedAt: new Date().toISOString(),
  });
  if (!r.ok) throw new Error(`grant failed: ${r.error}`);
}

describe("workspace-authz cross-user denial", () => {
  it("requireWorkspaceMember resolves for the owner and 403s for an unaffiliated user", async () => {
    const userA = uid();
    const userB = uid();
    const wsAlpha = w();
    await grant(userA, wsAlpha, "owner");

    const ctxA = await ctxFor(userA);
    const ctxB = await ctxFor(userB);

    const membershipA = await requireWorkspaceMember(ctxA, wsAlpha);
    expect(membershipA.role).toBe("owner");

    await expect(requireWorkspaceMember(ctxB, wsAlpha)).rejects.toThrow(HTTPException);
    try {
      await requireWorkspaceMember(ctxB, wsAlpha);
    } catch (error) {
      expect((error as HTTPException).status).toBe(403);
    }
  });

  it("requireWorkspaceMember 403s for a workspace the user has no row for", async () => {
    const userA = uid();
    const wsAlpha = w();
    const wsBeta = w();
    await grant(userA, wsAlpha, "owner");

    const ctxA = await ctxFor(userA);

    await expect(requireWorkspaceMember(ctxA, wsBeta)).rejects.toThrow(HTTPException);
  });

  it("requireWorkspaceAdmin 403s for member/agent roles, resolves for admin/owner", async () => {
    const ws = w();
    const owner = uid();
    const admin = uid();
    const member = uid();
    const agent = uid();
    await grant(owner, ws, "owner");
    await grant(admin, ws, "admin");
    await grant(member, ws, "member");
    await grant(agent, ws, "agent");

    const passes = [owner, admin];
    for (const u of passes) {
      const result = await requireWorkspaceAdmin(await ctxFor(u), ws);
      expect(["owner", "admin"]).toContain(result.role);
    }

    for (const u of [member, agent]) {
      await expect(requireWorkspaceAdmin(await ctxFor(u), ws)).rejects.toThrow(HTTPException);
    }
  });

  it("getAccessibleWorkspaceIds returns exactly the workspaces the user holds a row in", async () => {
    const u1 = uid();
    const u2 = uid();
    const wsA = w();
    const wsB = w();
    const wsC = w();
    await grant(u1, wsA, "owner");
    await grant(u1, wsB, "member");
    await grant(u2, wsC, "owner");

    const accessU1 = await getAccessibleWorkspaceIds(u1);
    expect([...accessU1].sort()).toEqual([wsA, wsB].sort());

    const accessU2 = await getAccessibleWorkspaceIds(u2);
    expect([...accessU2]).toEqual([wsC]);

    // Stranger sees nothing.
    const accessStranger = await getAccessibleWorkspaceIds(uid());
    expect([...accessStranger]).toEqual([]);
  });

  it("requireWorkspaceMember 401s when ctx.userId is unset", async () => {
    const ctx = await ctxFor(undefined);

    await expect(requireWorkspaceMember(ctx, w())).rejects.toThrow(HTTPException);
    try {
      await requireWorkspaceMember(ctx, w());
    } catch (error) {
      expect((error as HTTPException).status).toBe(401);
    }
  });
});

describe("daemon-shaped onError preserves HTTPException status", () => {
  // The route-level tests catch HTTPException via Hono's default
  // handler — which means a regression in the daemon's *global*
  // `app.onError()` (the one that previously flattened every thrown
  // error to 500) wouldn't show up unless we also exercise that
  // handler. This rebuilds the daemon's installed pattern in
  // isolation: a Hono app with an onError that lets HTTPException
  // self-respond and falls through to 500 otherwise.
  function buildAppWithDaemonOnError(): Hono {
    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof HTTPException) return err.getResponse();
      return c.json({ error: "Internal server error" }, 500);
    });
    app.get("/forbid", () => {
      throw new HTTPException(403, { message: "Forbidden" });
    });
    app.get("/unauth", () => {
      throw new HTTPException(401, { message: "Unauthorized" });
    });
    app.get("/oops", () => {
      throw new Error("oops");
    });
    return app;
  }

  it("returns 403 when a route throws HTTPException(403)", async () => {
    const app = buildAppWithDaemonOnError();
    const res = await app.request("/forbid");
    expect(res.status).toBe(403);
  });

  it("returns 401 when a route throws HTTPException(401)", async () => {
    const app = buildAppWithDaemonOnError();
    const res = await app.request("/unauth");
    expect(res.status).toBe(401);
  });

  it("still flattens non-HTTPException throws to 500", async () => {
    const app = buildAppWithDaemonOnError();
    const res = await app.request("/oops");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Internal server error");
  });
});
