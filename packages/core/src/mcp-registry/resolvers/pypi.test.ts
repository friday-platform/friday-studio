import { describe, expect, it } from "vitest";
import { createPypiResolver } from "./pypi.ts";

function stubFetch(map: Record<string, number>): { fetch: (url: string) => Promise<Response> } {
  return {
    // deno-lint-ignore require-await
    fetch: async (url: string) => {
      const status = map[url];
      if (status === undefined) throw new Error(`unstubbed URL ${url}`);
      return new Response("{}", { status });
    },
  };
}

describe("pypi resolver", () => {
  describe("matches", () => {
    const resolver = createPypiResolver(stubFetch({}));

    it("matches `uvx <pkg>`", () => {
      expect(resolver.matches("uvx", ["mcp-server-time"])).toEqual({ ref: "mcp-server-time" });
    });

    it("strips version specifiers", () => {
      expect(resolver.matches("uvx", ["mcp-server-time==1.2.3"])).toEqual({
        ref: "mcp-server-time",
      });
    });

    it("honors --from override", () => {
      expect(resolver.matches("uvx", ["--from", "the-real-pkg", "bin-name"])).toEqual({
        ref: "the-real-pkg",
      });
    });

    it("matches `pipx run <pkg>`", () => {
      expect(resolver.matches("pipx", ["run", "some-pkg"])).toEqual({ ref: "some-pkg" });
    });

    it("honors `pipx run --spec`", () => {
      expect(resolver.matches("pipx", ["run", "--spec", "override-pkg", "entrypoint"])).toEqual({
        ref: "override-pkg",
      });
    });

    it("ignores non-python commands", () => {
      expect(resolver.matches("npx", ["-y", "pkg"])).toBeNull();
      expect(resolver.matches("uv", ["run", "pkg"])).toBeNull();
    });

    it("bails on `pipx` without `run` subcommand", () => {
      expect(resolver.matches("pipx", ["install", "pkg"])).toBeNull();
    });
  });

  describe("check", () => {
    it("returns ok on 200", async () => {
      const resolver = createPypiResolver(
        stubFetch({ "https://pypi.org/pypi/mcp-server-time/json": 200 }),
      );
      await expect(resolver.check("mcp-server-time")).resolves.toEqual({ ok: true });
    });

    it("returns not_found on 404", async () => {
      const resolver = createPypiResolver(
        stubFetch({ "https://pypi.org/pypi/hallucinated-pkg/json": 404 }),
      );
      await expect(resolver.check("hallucinated-pkg")).resolves.toEqual({
        ok: false,
        reason: "not_found",
      });
    });

    it("returns unreachable on 5xx", async () => {
      const resolver = createPypiResolver(
        stubFetch({ "https://pypi.org/pypi/anything/json": 503 }),
      );
      await expect(resolver.check("anything")).resolves.toEqual({
        ok: false,
        reason: "unreachable",
      });
    });

    it("caches results", async () => {
      let calls = 0;
      const resolver = createPypiResolver({
        // deno-lint-ignore require-await
        fetch: async () => {
          calls++;
          return new Response("{}", { status: 200 });
        },
      });
      await resolver.check("same-pkg");
      await resolver.check("same-pkg");
      expect(calls).toBe(1);
    });
  });
});
