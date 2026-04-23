import { describe, expect, it } from "vitest";
import { createNpmResolver } from "./npm.ts";

function stubFetch(map: Record<string, { status: number; body?: unknown }>): {
  fetch: (url: string) => Promise<Response>;
} {
  return {
    // deno-lint-ignore require-await
    fetch: async (url: string) => {
      const entry = map[url];
      if (!entry) {
        throw new Error(`Test bug: unstubbed URL ${url}`);
      }
      return new Response(entry.body ? JSON.stringify(entry.body) : null, { status: entry.status });
    },
  };
}

describe("npm resolver", () => {
  describe("matches", () => {
    const resolver = createNpmResolver(stubFetch({}));

    it("matches `npx -y @scope/name`", () => {
      expect(resolver.matches("npx", ["-y", "@scope/name"])).toEqual({ ref: "@scope/name" });
    });

    it("matches `npx @scope/name` without -y", () => {
      expect(resolver.matches("npx", ["@scope/name"])).toEqual({ ref: "@scope/name" });
    });

    it("strips trailing version from bare packages", () => {
      expect(resolver.matches("npx", ["-y", "mcp-server-sqlite-npx@1.2.3"])).toEqual({
        ref: "mcp-server-sqlite-npx",
      });
    });

    it("strips trailing version from scoped packages", () => {
      expect(resolver.matches("npx", ["-y", "@stripe/mcp@latest"])).toEqual({ ref: "@stripe/mcp" });
    });

    it("matches bunx", () => {
      expect(resolver.matches("bunx", ["-y", "some-pkg"])).toEqual({ ref: "some-pkg" });
    });

    it("matches `pnpm dlx`", () => {
      expect(resolver.matches("pnpm", ["dlx", "some-pkg"])).toEqual({ ref: "some-pkg" });
    });

    it("ignores non-npm commands", () => {
      expect(resolver.matches("uvx", ["mcp-server"])).toBeNull();
      expect(resolver.matches("python", ["-m", "mcp"])).toBeNull();
      expect(resolver.matches("/usr/bin/server", [])).toBeNull();
    });

    it("bails on unknown flags", () => {
      // Avoid misidentifying a flag argument as the package name.
      expect(resolver.matches("npx", ["--registry", "https://example.com", "pkg"])).toBeNull();
    });
  });

  describe("check", () => {
    it("returns ok for 200", async () => {
      const resolver = createNpmResolver(
        stubFetch({
          "https://registry.npmjs.org/mcp-server-sqlite-npx": { status: 200, body: {} },
        }),
      );
      await expect(resolver.check("mcp-server-sqlite-npx")).resolves.toEqual({ ok: true });
    });

    it("returns not_found for 404 — the Yena bug", async () => {
      // Regression for the specific hallucination that led here.
      const resolver = createNpmResolver(
        stubFetch({
          "https://registry.npmjs.org/@joshuarileydev%2Fsqlite-mcp-server": { status: 404 },
        }),
      );
      await expect(resolver.check("@joshuarileydev/sqlite-mcp-server")).resolves.toEqual({
        ok: false,
        reason: "not_found",
      });
    });

    it("URL-encodes the slash in scoped package names", async () => {
      const resolver = createNpmResolver(
        stubFetch({ "https://registry.npmjs.org/@scope%2Fname": { status: 200, body: {} } }),
      );
      // If encoding were wrong the stub would throw (unstubbed URL).
      await expect(resolver.check("@scope/name")).resolves.toEqual({ ok: true });
    });

    it("returns auth_required for 401 and 403", async () => {
      const resolver = createNpmResolver(
        stubFetch({ "https://registry.npmjs.org/@private%2Fpkg": { status: 401 } }),
      );
      await expect(resolver.check("@private/pkg")).resolves.toEqual({
        ok: false,
        reason: "auth_required",
      });
    });

    it("returns unreachable on 5xx", async () => {
      const resolver = createNpmResolver(
        stubFetch({ "https://registry.npmjs.org/anything": { status: 502 } }),
      );
      await expect(resolver.check("anything")).resolves.toEqual({
        ok: false,
        reason: "unreachable",
      });
    });

    it("returns unreachable on network error", async () => {
      const resolver = createNpmResolver({
        fetch: () => Promise.reject(new Error("network down")),
      });
      await expect(resolver.check("anything")).resolves.toEqual({
        ok: false,
        reason: "unreachable",
      });
    });

    it("caches results — second check is a hit", async () => {
      let calls = 0;
      const resolver = createNpmResolver({
        // deno-lint-ignore require-await
        fetch: async () => {
          calls++;
          return new Response("{}", { status: 200 });
        },
      });
      await resolver.check("cached-pkg");
      await resolver.check("cached-pkg");
      expect(calls).toBe(1);
    });
  });
});
