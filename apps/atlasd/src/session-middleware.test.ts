/**
 * Integration test for the cookie-bearing session middleware.
 *
 * Verifies: local-mode auto-mint, cookie set on the response, valid
 * token round-trip via Bearer + cookie, kv.delete forces re-mint in
 * local mode and 401 in non-local mode.
 */

import { initSessionStorage, SessionStorage } from "@atlas/core/sessions/storage";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { initUserStorage, UserStorage } from "@atlas/core/users/storage";
import { Hono } from "hono";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionMiddleware } from "./session-middleware.ts";

let server: TestNatsServer;
let nc: NatsConnection;
let localUserId: string;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initUserStorage(nc);
  initSessionStorage(nc);
  const resolved = await UserStorage.resolveLocalUserId();
  if (!resolved.ok) throw new Error("local-user-id-resolve");
  localUserId = resolved.data;
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

function makeApp(devEnv: () => boolean): Hono<{ Variables: { userId?: string } }> {
  const app = new Hono<{ Variables: { userId?: string } }>();
  app.use("*", createSessionMiddleware({ devEnv }));
  app.get("/whoami", (c) => c.json({ userId: c.get("userId") ?? null }));
  return app;
}

function parseSetCookie(headerValue: string | null): { name?: string; value?: string } {
  if (!headerValue) return {};
  const [pair] = headerValue.split(";");
  if (!pair) return {};
  const eq = pair.indexOf("=");
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
}

describe("session middleware (dev env)", () => {
  const app = makeApp(() => true);

  it("auto-mints a session on first request and attaches Set-Cookie", async () => {
    const res = await app.request("/whoami");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string | null };
    expect(body.userId).toBe(localUserId);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const { name, value } = parseSetCookie(setCookie);
    expect(name).toBe("friday_session");
    expect(value).toBeTruthy();
    // Session record exists in KV.
    const lookup = await SessionStorage.getSession(value ?? "");
    expect(lookup.ok && lookup.data?.userId).toBe(localUserId);
  });

  it("re-uses the session when the cookie is presented on a subsequent request", async () => {
    const first = await app.request("/whoami");
    const firstCookie = parseSetCookie(first.headers.get("set-cookie"));
    expect(firstCookie.value).toBeTruthy();

    const second = await app.request("/whoami", {
      headers: { cookie: `friday_session=${firstCookie.value}` },
    });
    expect(second.status).toBe(200);
    const setCookie = second.headers.get("set-cookie");
    // No new cookie issued — middleware reused the existing session.
    expect(setCookie).toBeNull();
  });

  it("accepts an Authorization: Bearer token", async () => {
    const created = await SessionStorage.createSession(localUserId);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = await app.request("/whoami", {
      headers: { authorization: `Bearer ${created.data.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string | null };
    expect(body.userId).toBe(localUserId);
  });

  it("mints a new session when the cookie token has been revoked", async () => {
    const created = await SessionStorage.createSession(localUserId);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await SessionStorage.deleteSession(created.data.token);

    const res = await app.request("/whoami", {
      headers: { cookie: `friday_session=${created.data.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();
  });
});

describe("session middleware (non-dev env)", () => {
  const app = makeApp(() => false);

  it("401s on missing cookie / bearer", async () => {
    const res = await app.request("/whoami");
    expect(res.status).toBe(401);
  });

  it("401s on revoked token", async () => {
    const created = await SessionStorage.createSession(localUserId);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await SessionStorage.deleteSession(created.data.token);

    const res = await app.request("/whoami", {
      headers: { cookie: `friday_session=${created.data.token}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid Bearer token", async () => {
    const created = await SessionStorage.createSession(localUserId);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = await app.request("/whoami", {
      headers: { authorization: `Bearer ${created.data.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string | null };
    expect(body.userId).toBe(localUserId);
  });
});
