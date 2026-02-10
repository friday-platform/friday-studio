import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { getAuthToken, runWithAuthToken } from "./auth-context.ts";

describe("auth-context", () => {
  it("supports nested contexts with proper restore", () => {
    runWithAuthToken("outer", () => {
      expect(getAuthToken()).toBe("outer");
      runWithAuthToken("inner", () => {
        expect(getAuthToken()).toBe("inner");
      });
      expect(getAuthToken()).toBe("outer");
    });
    expect(() => getAuthToken()).toThrow("called outside request context");
  });

  it("isolates concurrent async contexts", async () => {
    const results: string[] = [];

    await Promise.all([
      runWithAuthToken("token-a", async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(`a:${getAuthToken()}`);
      }),
      runWithAuthToken("token-b", async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(`b:${getAuthToken()}`);
      }),
    ]);

    expect(results).toContain("a:token-a");
    expect(results).toContain("b:token-b");
    expect(results).toHaveLength(2);
  });

  it("propagates token through Hono middleware to downstream handlers", async () => {
    const app = new Hono();

    app.use((c, next) => {
      const authHeader = c.req.header("Authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
      return runWithAuthToken(token, () => next());
    });

    app.get("/test", (c) => c.json({ token: getAuthToken() }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer my-secret-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "my-secret-token" });
  });
});
