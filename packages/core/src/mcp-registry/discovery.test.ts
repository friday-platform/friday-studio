import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerMetadata } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks (available in vi.mock factories)
// ---------------------------------------------------------------------------

const mockRegistryServers = vi.hoisted(() => ({}) as Record<string, MCPServerMetadata>);
const mockAdapterList = vi.hoisted(() => vi.fn().mockResolvedValue([] as MCPServerMetadata[]));
const mockParseResult = vi.hoisted(() => vi.fn());

vi.mock("./registry-consolidated.ts", () => ({
  mcpServersRegistry: {
    servers: mockRegistryServers,
    metadata: { version: "1.0.0", lastUpdated: "2026-01-01" },
  },
}));

vi.mock("./storage/index.ts", () => ({
  getMCPRegistryAdapter: vi.fn().mockResolvedValue({ list: mockAdapterList }),
}));

vi.mock("@atlas/client/v2", () => ({
  client: { workspace: { ":workspaceId": { config: { $get: vi.fn() } } } },
  parseResult: (...args: unknown[]) => mockParseResult(...args),
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import process from "node:process";
import { discoverMCPServers, type LinkSummary } from "./discovery.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStaticServer(id: string, config: Partial<MCPServerMetadata> = {}): MCPServerMetadata {
  return {
    id,
    name: id,
    source: "static",
    securityRating: "high",
    configTemplate: { transport: { type: "stdio", command: "echo", args: ["hello"] } },
    ...config,
  } as MCPServerMetadata;
}

function makeRegistryServer(
  id: string,
  config: Partial<MCPServerMetadata> = {},
): MCPServerMetadata {
  return {
    id,
    name: id,
    source: "registry",
    securityRating: "medium",
    configTemplate: { transport: { type: "stdio", command: "echo", args: ["hello"] } },
    ...config,
  } as MCPServerMetadata;
}

function makeWorkspaceConfig(servers: Record<string, MCPServerConfig>): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { name: "test", description: "test" },
    tools: {
      mcp: {
        client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
        servers,
      },
    },
  } as unknown as WorkspaceConfig;
}

function makeLinkSummary(credentials: Array<{ provider: string }>): LinkSummary {
  return { providers: credentials.map((c) => ({ id: c.provider })), credentials };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  // Reset mocks and state
  for (const k of Object.keys(mockRegistryServers)) {
    delete mockRegistryServers[k];
  }
  mockAdapterList.mockReset();
  mockAdapterList.mockResolvedValue([]);
  mockParseResult.mockReset();

  // Save process.env
  originalEnv = { ...process.env };
});

beforeEach(() => {
  // Restore process.env after each test
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverMCPServers", () => {
  describe("server enumeration", () => {
    it("returns static blessed servers", async () => {
      mockRegistryServers.staticServer = makeStaticServer("static-server");

      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}));

      expect(result).toHaveLength(1);
      expect(result[0]?.metadata.id).toEqual("static-server");
      expect(result[0]?.metadata.source).toEqual("static");
      expect(result[0]?.configured).toBe(true);
    });

    it("returns registry-imported servers", async () => {
      const registryEntry = makeRegistryServer("registry-server");
      mockAdapterList.mockResolvedValue([registryEntry]);

      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}));

      expect(result).toHaveLength(1);
      expect(result[0]?.metadata.id).toEqual("registry-server");
      expect(result[0]?.metadata.source).toEqual("registry");
    });

    it("returns workspace-only servers with source: workspace", async () => {
      const wsConfig = makeWorkspaceConfig({
        "ws-only": { transport: { type: "stdio", command: "npx", args: ["-y", "@test/server"] } },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);

      const wsOnly = result.find((r) => r.metadata.id === "ws-only");
      expect(wsOnly).toBeDefined();
      expect(wsOnly?.metadata.source).toEqual("workspace");
      expect(wsOnly?.metadata.securityRating).toEqual("unverified");
      expect(wsOnly?.metadata.name).toEqual("ws-only");
    });

    it("combines all three sources", async () => {
      mockRegistryServers.staticServer = makeStaticServer("static-server");
      mockAdapterList.mockResolvedValue([makeRegistryServer("registry-server")]);
      const wsConfig = makeWorkspaceConfig({
        "ws-only": { transport: { type: "stdio", command: "npx", args: ["-y", "@test/server"] } },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);

      expect(result).toHaveLength(3);
      const ids = result.map((r) => r.metadata.id).sort();
      expect(ids).toEqual(["registry-server", "static-server", "ws-only"]);
    });

    it("caps at 50 servers", async () => {
      for (let i = 0; i < 30; i++) {
        mockRegistryServers[`static-${i}`] = makeStaticServer(`static-${i}`);
      }
      mockAdapterList.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => makeRegistryServer(`registry-${i}`)),
      );

      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}));

      expect(result).toHaveLength(50);
    });
  });

  describe("workspace overrides", () => {
    it("merges workspace overrides into static configTemplate", async () => {
      mockRegistryServers.github = makeStaticServer("github", {
        configTemplate: {
          transport: { type: "http", url: "https://api.githubcopilot.com/mcp" },
          env: { GH_TOKEN: { from: "link", provider: "github", key: "access_token" } },
        },
      });

      const wsConfig = makeWorkspaceConfig({
        github: {
          transport: { type: "http", url: "https://custom.github.com/mcp" },
          env: { GH_TOKEN: "custom-token" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const github = result.find((r) => r.metadata.id === "github");
      expect(github).toBeDefined();

      expect(github?.mergedConfig.transport).toEqual({
        type: "http",
        url: "https://custom.github.com/mcp",
      });
      expect(github?.mergedConfig.env).toEqual({ GH_TOKEN: "custom-token" });
    });

    it("preserves base env keys when workspace only overrides some", async () => {
      mockRegistryServers["multi-env"] = makeStaticServer("multi-env", {
        configTemplate: {
          transport: { type: "stdio", command: "echo" },
          env: { BASE_KEY: "base-value", OVERRIDE_KEY: "old-value" },
        },
      });

      const wsConfig = makeWorkspaceConfig({
        "multi-env": {
          transport: { type: "stdio", command: "echo" },
          env: { OVERRIDE_KEY: "new-value" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "multi-env");
      expect(entry).toBeDefined();

      expect(entry?.mergedConfig.env).toEqual({
        BASE_KEY: "base-value",
        OVERRIDE_KEY: "new-value",
      });
    });

    it("merges platformEnv into startup.env at discovery time", async () => {
      mockRegistryServers["platform-server"] = makeStaticServer("platform-server", {
        configTemplate: {
          transport: { type: "http", url: "http://localhost:8001/mcp" },
          startup: {
            type: "command",
            command: "uvx",
            args: ["workspace-mcp"],
            env: { WORKSPACE_MCP_PORT: "8001" },
          },
        },
        platformEnv: { GOOGLE_OAUTH_CLIENT_ID: "test-client-id", MCP_ENABLE_OAUTH21: "true" },
      } as Partial<MCPServerMetadata>);

      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}));
      const entry = result.find((r) => r.metadata.id === "platform-server");
      expect(entry).toBeDefined();

      expect(entry?.mergedConfig.startup?.env).toEqual({
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        MCP_ENABLE_OAUTH21: "true",
        WORKSPACE_MCP_PORT: "8001",
      });
    });

    it("workspace startup.env overrides platformEnv", async () => {
      mockRegistryServers["platform-server"] = makeStaticServer("platform-server", {
        configTemplate: {
          transport: { type: "http", url: "http://localhost:8001/mcp" },
          startup: {
            type: "command",
            command: "uvx",
            args: ["workspace-mcp"],
            env: { WORKSPACE_MCP_PORT: "8001" },
          },
        },
        platformEnv: { GOOGLE_OAUTH_CLIENT_ID: "base-client-id" },
      } as Partial<MCPServerMetadata>);

      const wsConfig = makeWorkspaceConfig({
        "platform-server": {
          transport: { type: "http", url: "http://localhost:8001/mcp" },
          startup: {
            type: "command",
            command: "uvx",
            args: ["workspace-mcp"],
            env: { GOOGLE_OAUTH_CLIENT_ID: "override-client-id", WORKSPACE_MCP_PORT: "8001" },
          },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "platform-server");
      expect(entry).toBeDefined();

      // platformEnv forms the base; workspace startup.env takes precedence
      expect(entry?.mergedConfig.startup?.env).toEqual({
        GOOGLE_OAUTH_CLIENT_ID: "override-client-id",
        WORKSPACE_MCP_PORT: "8001",
      });
    });
  });

  describe("workspace-only server description propagation", () => {
    it("propagates workspace config description into metadata", async () => {
      const wsConfig = makeWorkspaceConfig({
        "my-server": {
          transport: { type: "stdio", command: "echo" },
          description: "My custom MCP server",
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "my-server");
      expect(entry).toBeDefined();

      expect(entry?.metadata.description).toEqual("My custom MCP server");
    });

    it("leaves metadata description empty when not provided", async () => {
      const wsConfig = makeWorkspaceConfig({
        "my-server": { transport: { type: "stdio", command: "echo" } },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "my-server");
      expect(entry).toBeDefined();

      expect(entry?.metadata.description).toBeUndefined();
    });
  });

  describe("credential checking — Link-backed", () => {
    it("returns configured: true when Link has a credential for the provider", async () => {
      mockRegistryServers.linear = makeStaticServer("linear", {
        configTemplate: {
          transport: { type: "http", url: "https://mcp.linear.app/mcp" },
          auth: { type: "bearer", token_env: "LINEAR_ACCESS_TOKEN" },
          env: { LINEAR_ACCESS_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
        },
      });

      const linkSummary = makeLinkSummary([{ provider: "linear" }]);
      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}), linkSummary);

      const linear = result.find((r) => r.metadata.id === "linear");
      expect(linear).toBeDefined();
      expect(linear?.configured).toBe(true);
    });

    it("returns configured: false when Link has no credential for the provider", async () => {
      mockRegistryServers.linear = makeStaticServer("linear", {
        configTemplate: {
          transport: { type: "http", url: "https://mcp.linear.app/mcp" },
          env: { LINEAR_ACCESS_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
        },
      });

      const linkSummary = makeLinkSummary([]);
      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}), linkSummary);

      const linear = result.find((r) => r.metadata.id === "linear");
      expect(linear).toBeDefined();
      expect(linear?.configured).toBe(false);
    });

    it("returns configured: true when multiple Link credentials exist", async () => {
      mockRegistryServers.slack = makeStaticServer("slack", {
        configTemplate: {
          transport: { type: "stdio", command: "npx", args: ["-y", "mcp-slack"] },
          env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "access_token" } },
        },
      });

      const linkSummary = makeLinkSummary([{ provider: "slack" }, { provider: "slack" }]);
      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}), linkSummary);

      const slack = result.find((r) => r.metadata.id === "slack");
      expect(slack).toBeDefined();
      expect(slack?.configured).toBe(true);
    });

    it("returns configured: true even when the single credential is expired", async () => {
      mockRegistryServers.github = makeStaticServer("github", {
        configTemplate: {
          transport: { type: "http", url: "https://api.githubcopilot.com/mcp" },
          env: { GH_TOKEN: { from: "link", provider: "github", key: "access_token" } },
        },
      });

      const linkSummary = makeLinkSummary([{ provider: "github" }]);
      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}), linkSummary);

      const github = result.find((r) => r.metadata.id === "github");
      expect(github).toBeDefined();
      expect(github?.configured).toBe(true);
    });
  });

  describe("credential checking — string env vars", () => {
    it("returns configured: false for placeholder env values", async () => {
      const wsConfig = makeWorkspaceConfig({
        "custom-api": {
          transport: { type: "http", url: "https://api.example.com" },
          env: { API_KEY: "your-api-key" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "custom-api");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(false);
    });

    it("returns configured: true for resolved string env values", async () => {
      const wsConfig = makeWorkspaceConfig({
        "custom-api": {
          transport: { type: "http", url: "https://api.example.com" },
          env: { API_KEY: "sk-live-real-key" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "custom-api");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(true);
    });

    it("returns configured: false when auto env var is missing from process.env", async () => {
      delete process.env.MY_AUTO_KEY;

      const wsConfig = makeWorkspaceConfig({
        "auto-server": {
          transport: { type: "stdio", command: "echo" },
          env: { MY_AUTO_KEY: "auto" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "auto-server");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(false);
    });

    it("returns configured: true when auto env var is present in process.env", async () => {
      process.env.MY_AUTO_KEY = "resolved-value";

      const wsConfig = makeWorkspaceConfig({
        "auto-server": {
          transport: { type: "stdio", command: "echo" },
          env: { MY_AUTO_KEY: "auto" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "auto-server");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(true);
    });

    it("returns configured: false when auto env var in process.env is a placeholder", async () => {
      process.env.MY_AUTO_KEY = "your-api-key";

      const wsConfig = makeWorkspaceConfig({
        "auto-server": {
          transport: { type: "stdio", command: "echo" },
          env: { MY_AUTO_KEY: "auto" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "auto-server");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(false);
    });

    it("returns configured: false for from_environment when missing", async () => {
      delete process.env.MY_FROM_ENV;

      const wsConfig = makeWorkspaceConfig({
        "from-env-server": {
          transport: { type: "stdio", command: "echo" },
          env: { MY_FROM_ENV: "from_environment" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "from-env-server");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(false);
    });

    it("returns configured: true for from_environment when present", async () => {
      process.env.MY_FROM_ENV = "real-value";

      const wsConfig = makeWorkspaceConfig({
        "from-env-server": {
          transport: { type: "stdio", command: "echo" },
          env: { MY_FROM_ENV: "from_environment" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "from-env-server");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(true);
    });

    it("returns configured: true when no env vars are required", async () => {
      mockRegistryServers.time = makeStaticServer("time", {
        configTemplate: { transport: { type: "stdio", command: "uvx", args: ["mcp-server-time"] } },
      });

      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}));
      const time = result.find((r) => r.metadata.id === "time");
      expect(time).toBeDefined();
      expect(time?.configured).toBe(true);
    });
  });

  describe("credential checking — auth.token_env fallback", () => {
    it("returns configured: false when auth.token_env is not in env and process.env lacks it", async () => {
      delete process.env.FALLBACK_TOKEN;

      mockRegistryServers.tokenOnly = makeStaticServer("token-only", {
        configTemplate: {
          transport: { type: "http", url: "https://api.example.com" },
          auth: { type: "bearer", token_env: "FALLBACK_TOKEN" },
        },
      });

      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}));
      const entry = result.find((r) => r.metadata.id === "token-only");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(false);
    });

    it("returns configured: true when auth.token_env is not in env but process.env has it", async () => {
      process.env.FALLBACK_TOKEN = "real-token";

      mockRegistryServers.tokenOnly = makeStaticServer("token-only", {
        configTemplate: {
          transport: { type: "http", url: "https://api.example.com" },
          auth: { type: "bearer", token_env: "FALLBACK_TOKEN" },
        },
      });

      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}));
      const entry = result.find((r) => r.metadata.id === "token-only");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(true);
    });
  });

  describe("workspace config fetch", () => {
    it("throws when workspace config fetch fails and no config is passed", async () => {
      mockParseResult.mockResolvedValue({ ok: false, error: new Error("Network error") });

      await expect(discoverMCPServers("ws-1")).rejects.toThrow("Failed to fetch workspace config");
    });

    it("does not fetch workspace config when passed as argument", async () => {
      const wsConfig = makeWorkspaceConfig({});
      mockParseResult.mockRejectedValue(new Error("Should not be called"));

      const result = await discoverMCPServers("ws-1", wsConfig);
      expect(result).toEqual([]);
      expect(mockParseResult).not.toHaveBeenCalled();
    });
  });

  describe("multiple env var resolution", () => {
    it("returns configured: false when any string env var is a placeholder", async () => {
      const wsConfig = makeWorkspaceConfig({
        multi: {
          transport: { type: "stdio", command: "echo" },
          env: { KEY_A: "resolved-value", KEY_B: "your-api-key" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "multi");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(false);
    });

    it("returns configured: true when all string env vars are resolved", async () => {
      const wsConfig = makeWorkspaceConfig({
        multi: {
          transport: { type: "stdio", command: "echo" },
          env: { KEY_A: "resolved-a", KEY_B: "resolved-b" },
        },
      });

      const result = await discoverMCPServers("ws-1", wsConfig);
      const entry = result.find((r) => r.metadata.id === "multi");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(true);
    });

    it("returns configured: false when any Link ref provider is missing", async () => {
      mockRegistryServers.mixed = makeStaticServer("mixed", {
        configTemplate: {
          transport: { type: "stdio", command: "echo" },
          env: {
            GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" },
            SLACK_TOKEN: { from: "link", provider: "slack", key: "access_token" },
          },
        },
      });

      const linkSummary = makeLinkSummary([{ provider: "github" }]);
      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}), linkSummary);
      const entry = result.find((r) => r.metadata.id === "mixed");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(false);
    });

    it("returns configured: true when all Link ref providers exist", async () => {
      mockRegistryServers.mixed = makeStaticServer("mixed", {
        configTemplate: {
          transport: { type: "stdio", command: "echo" },
          env: {
            GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" },
            SLACK_TOKEN: { from: "link", provider: "slack", key: "access_token" },
          },
        },
      });

      const linkSummary = makeLinkSummary([{ provider: "github" }, { provider: "slack" }]);
      const result = await discoverMCPServers("ws-1", makeWorkspaceConfig({}), linkSummary);
      const entry = result.find((r) => r.metadata.id === "mixed");
      expect(entry).toBeDefined();
      expect(entry?.configured).toBe(true);
    });
  });
});
