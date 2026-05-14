import { describe, it } from "vitest";
import { envSink, routeEnvVars } from "./env-routing.ts";
import type { UpstreamEnvironmentVariable } from "./upstream-client.ts";

describe("routeEnvVars", () => {
  describe("need rule — four quadrants", () => {
    it("required + secret → Link ref, link key, required config", ({ expect }) => {
      const { env, linkKeys, requiredConfig } = routeEnvVars(
        [{ name: "API_TOKEN", description: "API token", isRequired: true, isSecret: true }],
        "my-provider",
      );

      expect(env).toEqual({
        API_TOKEN: { from: "link", provider: "my-provider", key: "API_TOKEN" },
      });
      expect(linkKeys).toEqual(["API_TOKEN"]);
      expect(requiredConfig).toEqual([
        { key: "API_TOKEN", description: "API token", type: "string" },
      ]);
    });

    it("required + non-secret → Link ref (required alone earns credential handling)", ({
      expect,
    }) => {
      const { env, linkKeys, requiredConfig } = routeEnvVars(
        [{ name: "WORKSPACE", description: "Workspace name", isRequired: true, isSecret: false }],
        "my-provider",
      );

      expect(env).toEqual({
        WORKSPACE: { from: "link", provider: "my-provider", key: "WORKSPACE" },
      });
      expect(linkKeys).toEqual(["WORKSPACE"]);
      expect(requiredConfig).toEqual([
        { key: "WORKSPACE", description: "Workspace name", type: "string" },
      ]);
    });

    it("optional + secret → Link ref, link key, but not required config", ({ expect }) => {
      const { env, linkKeys, requiredConfig } = routeEnvVars(
        [
          {
            name: "OPTIONAL_KEY",
            description: "Optional secret",
            isRequired: false,
            isSecret: true,
          },
        ],
        "my-provider",
      );

      expect(env).toEqual({
        OPTIONAL_KEY: { from: "link", provider: "my-provider", key: "OPTIONAL_KEY" },
      });
      expect(linkKeys).toEqual(["OPTIONAL_KEY"]);
      expect(requiredConfig).toEqual([]);
    });

    it("optional + non-secret with default → plain string carrying the default", ({ expect }) => {
      const { env, linkKeys, requiredConfig } = routeEnvVars(
        [{ name: "LOG_LEVEL", description: "Log level", isRequired: false, default: "info" }],
        "my-provider",
      );

      expect(env).toEqual({ LOG_LEVEL: "info" });
      expect(linkKeys).toEqual([]);
      expect(requiredConfig).toEqual([]);
    });

    it("optional + non-secret without default → empty string", ({ expect }) => {
      const { env, linkKeys, requiredConfig } = routeEnvVars(
        [{ name: "LOG_FILE", description: "Log file path", isRequired: false }],
        "my-provider",
      );

      expect(env).toEqual({ LOG_FILE: "" });
      expect(linkKeys).toEqual([]);
      expect(requiredConfig).toEqual([]);
    });
  });

  describe("default flags", () => {
    it("treats missing isRequired / isSecret as false (→ plain string)", ({ expect }) => {
      const { env, linkKeys } = routeEnvVars([{ name: "PLAIN" }], "my-provider");

      expect(env).toEqual({ PLAIN: "" });
      expect(linkKeys).toEqual([]);
    });
  });

  describe("requiredConfig details", () => {
    it("appends the placeholder as an example in the description", ({ expect }) => {
      const { requiredConfig } = routeEnvVars(
        [
          {
            name: "API_KEY",
            description: "API key for authentication",
            isRequired: true,
            placeholder: "sk_live_...",
          },
        ],
        "my-provider",
      );

      expect(requiredConfig).toEqual([
        {
          key: "API_KEY",
          description: "API key for authentication (e.g. sk_live_...)",
          type: "string",
        },
      ]);
    });

    it("carries the upstream default into examples for a required var", ({ expect }) => {
      const { requiredConfig } = routeEnvVars(
        [
          {
            name: "ENDPOINT",
            description: "API endpoint URL",
            isRequired: true,
            default: "https://api.example.com",
          },
        ],
        "my-provider",
      );

      expect(requiredConfig).toEqual([
        {
          key: "ENDPOINT",
          description: "API endpoint URL",
          type: "string",
          examples: ["https://api.example.com"],
        },
      ]);
    });

    it("falls back to the var name when no description is given", ({ expect }) => {
      const { requiredConfig } = routeEnvVars([{ name: "TOKEN", isRequired: true }], "my-provider");

      expect(requiredConfig).toEqual([{ key: "TOKEN", description: "TOKEN", type: "string" }]);
    });
  });

  it("handles an empty env var list", ({ expect }) => {
    expect(routeEnvVars([], "my-provider")).toEqual({ env: {}, linkKeys: [], requiredConfig: [] });
  });

  it("routes a Bitbucket-shaped entry — 3 required credentials + 7 optional settings", ({
    expect,
  }) => {
    const envVars: UpstreamEnvironmentVariable[] = [
      { name: "BITBUCKET_USERNAME", isRequired: true },
      { name: "BITBUCKET_APP_PASSWORD", isRequired: true, isSecret: true },
      { name: "BITBUCKET_WORKSPACE", isRequired: true },
      { name: "BITBUCKET_URL", isRequired: false, default: "https://api.bitbucket.org/2.0" },
      { name: "BITBUCKET_LOG_FILE", isRequired: false },
      { name: "BITBUCKET_LOG_LEVEL", isRequired: false, default: "info" },
      { name: "BITBUCKET_TIMEOUT", isRequired: false, default: "30" },
      { name: "BITBUCKET_MAX_RETRIES", isRequired: false, default: "3" },
      { name: "BITBUCKET_PAGE_SIZE", isRequired: false, default: "50" },
      { name: "BITBUCKET_VERIFY_SSL", isRequired: false, default: "true" },
    ];

    const { env, linkKeys, requiredConfig } = routeEnvVars(envVars, "bitbucket-mcp");

    // 3 required credentials → Link refs.
    expect(linkKeys).toEqual([
      "BITBUCKET_USERNAME",
      "BITBUCKET_APP_PASSWORD",
      "BITBUCKET_WORKSPACE",
    ]);
    expect(requiredConfig.map((f) => f.key)).toEqual([
      "BITBUCKET_USERNAME",
      "BITBUCKET_APP_PASSWORD",
      "BITBUCKET_WORKSPACE",
    ]);

    // The env block carries 3 Link refs + 7 plain strings.
    const linkRefs = Object.entries(env).filter(([, v]) => typeof v !== "string");
    const plainStrings = Object.entries(env).filter(([, v]) => typeof v === "string");
    expect(linkRefs).toHaveLength(3);
    expect(plainStrings).toHaveLength(7);

    expect(env.BITBUCKET_APP_PASSWORD).toEqual({
      from: "link",
      provider: "bitbucket-mcp",
      key: "BITBUCKET_APP_PASSWORD",
    });
    expect(env.BITBUCKET_URL).toBe("https://api.bitbucket.org/2.0");
    expect(env.BITBUCKET_LOG_FILE).toBe("");
  });
});

describe("envSink", () => {
  it("stdio → server-level env block", ({ expect }) => {
    expect(envSink({ type: "stdio", hasStartup: false })).toBe("server");
  });

  it("stdio with a startup block still reads the server-level env block", ({ expect }) => {
    expect(envSink({ type: "stdio", hasStartup: true })).toBe("server");
  });

  it("sidecar-less HTTP → server-level env block", ({ expect }) => {
    expect(envSink({ type: "http", hasStartup: false })).toBe("server");
  });

  it("HTTP with a startup sidecar → the sidecar's startup.env block", ({ expect }) => {
    expect(envSink({ type: "http", hasStartup: true })).toBe("startup");
  });
});
