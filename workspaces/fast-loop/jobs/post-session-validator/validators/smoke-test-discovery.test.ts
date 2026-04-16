import { describe, expect, it } from "vitest";
import { discoverRouteEndpoints } from "./smoke-test.ts";

describe("discoverRouteEndpoints", () => {
  it("extracts route files and maps to correct URL prefixes", () => {
    const changedFiles = [
      "apps/atlasd/routes/chat.ts",
      "apps/atlasd/routes/workspaces/index.ts",
      "packages/core/mod.ts",
    ];

    const endpoints = discoverRouteEndpoints(changedFiles);

    expect(endpoints).toHaveLength(2);
    expect(endpoints).toContainEqual({
      file: "apps/atlasd/routes/chat.ts",
      urlPrefix: "/api/chat",
    });
    expect(endpoints).toContainEqual({
      file: "apps/atlasd/routes/workspaces/index.ts",
      urlPrefix: "/api/workspaces",
    });
  });

  it("returns empty array when no route files changed", () => {
    const changedFiles = [
      "packages/core/mod.ts",
      "packages/agent-sdk/src/index.ts",
      "apps/atlasd/src/atlas-daemon.ts",
    ];

    const endpoints = discoverRouteEndpoints(changedFiles);
    expect(endpoints).toHaveLength(0);
  });

  it("maps global-chat route correctly", () => {
    const changedFiles = ["apps/atlasd/routes/global-chat.ts"];

    const endpoints = discoverRouteEndpoints(changedFiles);

    expect(endpoints).toEqual([
      { file: "apps/atlasd/routes/global-chat.ts", urlPrefix: "/api/global-chat" },
    ]);
  });

  it("maps workspace sub-routes correctly", () => {
    const changedFiles = [
      "apps/atlasd/routes/workspaces/chat.ts",
      "apps/atlasd/routes/workspaces/config.ts",
    ];

    const endpoints = discoverRouteEndpoints(changedFiles);

    expect(endpoints).toHaveLength(2);
    expect(endpoints).toContainEqual({
      file: "apps/atlasd/routes/workspaces/chat.ts",
      urlPrefix: "/api/workspaces/:workspaceId/chat",
    });
    expect(endpoints).toContainEqual({
      file: "apps/atlasd/routes/workspaces/config.ts",
      urlPrefix: "/api/workspaces/:workspaceId/config",
    });
  });

  it("ignores non-.ts files in routes directory", () => {
    const changedFiles = ["apps/atlasd/routes/README.md", "apps/atlasd/routes/.gitkeep"];

    const endpoints = discoverRouteEndpoints(changedFiles);
    expect(endpoints).toHaveLength(0);
  });

  it("ignores route files not in the mount map", () => {
    const changedFiles = ["apps/atlasd/routes/unknown-route.ts"];

    const endpoints = discoverRouteEndpoints(changedFiles);
    expect(endpoints).toHaveLength(0);
  });

  it("handles empty changedFiles array", () => {
    const endpoints = discoverRouteEndpoints([]);
    expect(endpoints).toHaveLength(0);
  });

  it("maps all known route files from the mount table", () => {
    const knownRouteFiles = [
      "apps/atlasd/routes/chat.ts",
      "apps/atlasd/routes/global-chat.ts",
      "apps/atlasd/routes/sessions.ts",
      "apps/atlasd/routes/agents.ts",
      "apps/atlasd/routes/skills.ts",
      "apps/atlasd/routes/memory.ts",
      "apps/atlasd/routes/logs.ts",
    ];

    const endpoints = discoverRouteEndpoints(knownRouteFiles);

    expect(endpoints).toHaveLength(7);
    expect(endpoints.map((e) => e.urlPrefix)).toEqual([
      "/api/chat",
      "/api/global-chat",
      "/api/sessions",
      "/api/agents",
      "/api/skills",
      "/api/memory",
      "/api/logs",
    ]);
  });
});
