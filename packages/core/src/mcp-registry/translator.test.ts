import { describe, it } from "vitest";
import type { MCPServerMetadata } from "./schemas.ts";
import { deriveId, type TranslateResult, translate } from "./translator.ts";
import type { UpstreamServerEntry } from "./upstream-client.ts";

/**
 * Type guard for successful translation result.
 */
function isSuccess(
  result: TranslateResult,
): result is {
  success: true;
  entry: MCPServerMetadata;
  linkProvider?: import("./translator.ts").DynamicProviderInput;
} {
  return result.success === true;
}

/**
 * Type guard for failed translation result.
 */
function isFailure(result: TranslateResult): result is { success: false; reason: string } {
  return result.success === false;
}

describe("deriveId", () => {
  it("converts dots to dashes", ({ expect }) => {
    expect(deriveId("io.github.example")).toBe("io-github-example");
  });

  it("converts slashes to dashes", ({ expect }) => {
    expect(deriveId("io/github/example")).toBe("io-github-example");
  });

  it("converts mixed dots and slashes to dashes", ({ expect }) => {
    expect(deriveId("io.github/Digital-Defiance/mcp-filesystem")).toBe(
      "io-github-digital-defiance-mcp-filesystem",
    );
  });

  it("converts to lowercase", ({ expect }) => {
    expect(deriveId("IO.GitHub.Example")).toBe("io-github-example");
  });

  it("truncates at 64 characters", ({ expect }) => {
    const longName = "a".repeat(100);
    expect(deriveId(longName)).toBe("a".repeat(64));
  });

  it("handles complex real-world names", ({ expect }) => {
    expect(deriveId("com.example.corp.mcp-server-name")).toBe("com-example-corp-mcp-server-name");
  });
});

describe("translate", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // SUCCESS CASES
  // ─────────────────────────────────────────────────────────────────────────

  describe("success cases", () => {
    it("npm stdio transport - happy path", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.github/Digital-Defiance/mcp-filesystem",
          description: "Filesystem access via MCP",
          version: "0.1.9",
          packages: [
            {
              registryType: "npm",
              identifier: "@digital-defiance/mcp-filesystem",
              version: "0.1.9",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-12-20T19:25:57.705316Z",
            publishedAt: "2025-12-20T19:25:57.705316Z",
            updatedAt: "2025-12-20T19:25:57.705316Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.id).toBe("io-github-digital-defiance-mcp-filesystem");
      expect(result.entry.name).toBe("io.github/Digital-Defiance/mcp-filesystem");
      expect(result.entry.description).toBe("Filesystem access via MCP");
      expect(result.entry.securityRating).toBe("unverified");
      expect(result.entry.source).toBe("registry");
      expect(result.entry.upstream).toEqual({
        canonicalName: "io.github/Digital-Defiance/mcp-filesystem",
        version: "0.1.9",
        updatedAt: "2025-12-20T19:25:57.705316Z",
      });
      expect(result.entry.configTemplate.transport).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@digital-defiance/mcp-filesystem@0.1.9"],
      });
    });

    it("npm stdio with environment variables - required and optional", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "com.example.api-server",
          description: "API server with env vars",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/api-server",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [
                {
                  name: "API_KEY",
                  description: "API key for authentication",
                  isRequired: true,
                  placeholder: "sk_live_...",
                },
                {
                  name: "DEBUG",
                  description: "Enable debug mode",
                  isRequired: false,
                  default: "false",
                },
                {
                  name: "ENDPOINT",
                  description: "API endpoint URL",
                  isRequired: true,
                  default: "https://api.example.com",
                },
              ],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      // Check requiredConfig contains required env vars
      expect(result.entry.requiredConfig).toHaveLength(2);
      expect(result.entry.requiredConfig).toContainEqual({
        key: "API_KEY",
        description: "API key for authentication (e.g. sk_live_...)",
        type: "string",
      });
      expect(result.entry.requiredConfig).toContainEqual({
        key: "ENDPOINT",
        description: "API endpoint URL", // No placeholder, so no "(e.g. ...)" appended
        type: "string",
        examples: ["https://api.example.com"],
      });

      // Check configTemplate.env uses Link credential references
      expect(result.entry.configTemplate.env).toEqual({
        API_KEY: { from: "link", provider: "com-example-api-server", key: "API_KEY" },
        DEBUG: { from: "link", provider: "com-example-api-server", key: "DEBUG" },
        ENDPOINT: { from: "link", provider: "com-example-api-server", key: "ENDPOINT" },
      });

      // Check linkProvider is DynamicApiKeyProviderInput
      expect(result.linkProvider).toEqual({
        type: "apikey",
        id: "com-example-api-server",
        displayName: "com.example.api-server",
        description: "API server with env vars",
        secretSchema: { API_KEY: "string", DEBUG: "string", ENDPOINT: "string" },
      });
    });

    it("streamable-http transport with no URL variables", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.github.example.http-server",
          description: "HTTP-based MCP server",
          version: "2.0.0",
          remotes: [{ type: "streamable-http", url: "https://mcp.example.com/v1/mcp" }],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-06-15T12:00:00.000000Z",
            publishedAt: "2025-06-15T12:00:00.000000Z",
            updatedAt: "2025-06-15T12:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.id).toBe("io-github-example-http-server");
      expect(result.entry.source).toBe("registry");
      expect(result.entry.securityRating).toBe("unverified");
      expect(result.entry.configTemplate.transport).toEqual({
        type: "http",
        url: "https://mcp.example.com/v1/mcp",
      });
      // OAuth wiring: env holds Link ref for access token, auth consumes it
      expect(result.entry.configTemplate.env).toEqual({
        IO_GITHUB_EXAMPLE_HTTP_SERVER_ACCESS_TOKEN: {
          from: "link",
          provider: "io-github-example-http-server",
          key: "access_token",
        },
      });
      expect(result.entry.configTemplate.auth).toEqual({
        type: "bearer",
        token_env: "IO_GITHUB_EXAMPLE_HTTP_SERVER_ACCESS_TOKEN",
      });
      expect(result.entry.requiredConfig).toEqual([
        {
          key: "IO_GITHUB_EXAMPLE_HTTP_SERVER_ACCESS_TOKEN",
          description: "OAuth access token for io-github-example-http-server from Link",
          type: "string",
        },
      ]);

      // Check linkProvider is DynamicOAuthProviderInput
      expect(result.linkProvider).toEqual({
        type: "oauth",
        id: "io-github-example-http-server",
        displayName: "io.github.example.http-server",
        description: "HTTP-based MCP server",
        oauthConfig: { mode: "discovery", serverUrl: "https://mcp.example.com/v1/mcp" },
      });
    });

    it("streamable-http with variables having defaults", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.saas-integration",
          description: "SaaS MCP integration",
          version: "1.5.0",
          remotes: [
            {
              type: "streamable-http",
              url: "https://{region}.saas.example.com/mcp",
              variables: {
                region: { description: "Server region", isRequired: true, default: "us-east-1" },
              },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-03-10T08:30:00.000000Z",
            publishedAt: "2025-03-10T08:30:00.000000Z",
            updatedAt: "2025-03-10T08:30:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.configTemplate.transport).toEqual({
        type: "http",
        url: "https://us-east-1.saas.example.com/mcp",
      });

      // Check linkProvider is DynamicOAuthProviderInput
      expect(result.linkProvider).toEqual({
        type: "oauth",
        id: "io-example-saas-integration",
        displayName: "io.example.saas-integration",
        description: "SaaS MCP integration",
        oauthConfig: { mode: "discovery", serverUrl: "https://us-east-1.saas.example.com/mcp" },
      });
    });

    it("streamable-http with env vars from packages → DynamicApiKeyProviderInput", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.http-with-env",
          description: "HTTP server with env vars from packages",
          version: "1.0.0",
          packages: [
            {
              registryType: "pypi",
              identifier: "http-env-server",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [
                { name: "API_KEY", description: "API key for authentication", isRequired: true },
                { name: "ENDPOINT", description: "Custom endpoint", isRequired: false },
              ],
            },
          ],
          remotes: [{ type: "streamable-http", url: "https://http-env.example.com/mcp" }],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      // HTTP transport wins (pypi stdio is rejected later, but http branch runs first)
      expect(result.entry.configTemplate.transport).toEqual({
        type: "http",
        url: "https://http-env.example.com/mcp",
      });

      // Env vars from packages become Link refs
      expect(result.entry.configTemplate.env).toEqual({
        API_KEY: { from: "link", provider: "io-example-http-with-env", key: "API_KEY" },
        ENDPOINT: { from: "link", provider: "io-example-http-with-env", key: "ENDPOINT" },
      });
      expect(result.entry.requiredConfig).toEqual([
        { key: "API_KEY", description: "API key for authentication", type: "string" },
      ]);

      // Link provider is apikey because env vars exist
      expect(result.linkProvider).toEqual({
        type: "apikey",
        id: "io-example-http-with-env",
        displayName: "io.example.http-with-env",
        description: "HTTP server with env vars from packages",
        secretSchema: { API_KEY: "string", ENDPOINT: "string" },
      });
    });

    it("npm stdio takes precedence over streamable-http", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.multi-transport",
          description: "Server with multiple transports",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/multi",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
          remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      // Should pick npm stdio (npx), not http
      expect(result.entry.configTemplate.transport).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@example/multi@1.0.0"],
      });

      // No env vars, so no linkProvider
      expect(result.linkProvider).toBeUndefined();
    });

    it("streamable-http used when no npm stdio available", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.http-only",
          description: "HTTP-only MCP server",
          version: "1.0.0",
          packages: [
            {
              registryType: "pypi",
              identifier: "http-only-server",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
          remotes: [{ type: "streamable-http", url: "https://http-only.example.com/mcp" }],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      // Should pick http (since pypi stdio is rejected, but streamable-http is available)
      expect(result.entry.configTemplate.transport).toEqual({
        type: "http",
        url: "https://http-only.example.com/mcp",
      });

      // No env vars from packages, so linkProvider is OAuth
      expect(result.linkProvider).toEqual({
        type: "oauth",
        id: "io-example-http-only",
        displayName: "io.example.http-only",
        description: "HTTP-only MCP server",
        oauthConfig: { mode: "discovery", serverUrl: "https://http-only.example.com/mcp" },
      });
    });

    it("handles complex multi-version scenario - 0.1.0 version", ({ expect }) => {
      // Simulating one version of a multi-version search result
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.github/Digital-Defiance/mcp-filesystem",
          description: "Filesystem access",
          version: "0.1.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@digital-defiance/mcp-filesystem",
              version: "0.1.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.id).toBe("io-github-digital-defiance-mcp-filesystem");
      expect(result.entry.upstream?.version).toBe("0.1.0");
      expect(result.entry.configTemplate.transport).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@digital-defiance/mcp-filesystem@0.1.0"],
      });
    });

    it("handles complex multi-version scenario - 0.1.9 version", ({ expect }) => {
      // Same server, different version - different npx command
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.github/Digital-Defiance/mcp-filesystem",
          description: "Filesystem access",
          version: "0.1.9",
          packages: [
            {
              registryType: "npm",
              identifier: "@digital-defiance/mcp-filesystem",
              version: "0.1.9",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-12-20T19:25:57.705316Z",
            publishedAt: "2025-12-20T19:25:57.705316Z",
            updatedAt: "2025-12-20T19:25:57.705316Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.upstream?.version).toBe("0.1.9");
      expect(result.entry.configTemplate.transport).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@digital-defiance/mcp-filesystem@0.1.9"],
      });
    });

    it("handles description-only environment variables (no placeholder)", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.simple-env",
          description: "Simple env vars",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/simple",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [
                { name: "SIMPLE_VAR", description: "A simple variable", isRequired: true },
              ],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.requiredConfig?.[0]?.description).toBe("A simple variable");

      expect(result.entry.configTemplate.env).toEqual({
        SIMPLE_VAR: { from: "link", provider: "io-example-simple-env", key: "SIMPLE_VAR" },
      });
      expect(result.linkProvider).toEqual({
        type: "apikey",
        id: "io-example-simple-env",
        displayName: "io.example.simple-env",
        description: "Simple env vars",
        secretSchema: { SIMPLE_VAR: "string" },
      });
    });

    it("handles environment variable with description and placeholder", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.placeholder-env",
          description: "Placeholder test",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/placeholder",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [
                {
                  name: "TOKEN",
                  description: "Authentication token",
                  isRequired: true,
                  placeholder: "ghp_xxxxxxxxxxxx",
                },
              ],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.requiredConfig?.[0]?.description).toBe(
        "Authentication token (e.g. ghp_xxxxxxxxxxxx)",
      );

      expect(result.entry.configTemplate.env).toEqual({
        TOKEN: { from: "link", provider: "io-example-placeholder-env", key: "TOKEN" },
      });
      expect(result.linkProvider).toEqual({
        type: "apikey",
        id: "io-example-placeholder-env",
        displayName: "io.example.placeholder-env",
        description: "Placeholder test",
        secretSchema: { TOKEN: "string" },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REJECT CASES
  // ─────────────────────────────────────────────────────────────────────────

  describe("reject cases", () => {
    it("rejects missing version field", ({ expect }) => {
      const fixture = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.no-version",
          description: "Missing version",
          // version is missing!
          packages: [
            {
              registryType: "npm",
              identifier: "@example/no-version",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture as UpstreamServerEntry);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("missing required field: version");
    });

    it("rejects SSE-only transport", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.sse-only",
          description: "SSE-only server",
          version: "1.0.0",
          remotes: [{ type: "sse", url: "https://sse.example.com/events" }],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("SSE transport");
      expect(result.reason).toContain("not yet supported");
    });

    it("rejects PyPI-only packages", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.pypi-only",
          description: "PyPI-only server",
          version: "1.0.0",
          packages: [
            {
              registryType: "pypi",
              identifier: "pypi-only-server",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("PyPI");
      expect(result.reason).toContain("not yet supported");
    });

    it("rejects Docker/OCI-only packages", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.docker-only",
          description: "Docker-only server",
          version: "1.0.0",
          packages: [
            {
              registryType: "oci",
              identifier: "docker.io/example/server",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("Docker/OCI");
      expect(result.reason).toContain("not yet supported");
    });

    it("rejects when no packages and no remotes", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.empty",
          description: "Empty server",
          version: "1.0.0",
          // No packages, no remotes
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("no installable packages or remote endpoints");
    });

    it("rejects streamable-http with unresolved URL variables (required without default)", ({
      expect,
    }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.unresolved-vars",
          description: "Server with unresolved vars",
          version: "1.0.0",
          remotes: [
            {
              type: "streamable-http",
              url: "https://{tenant_id}.example.com/mcp",
              variables: {
                tenant_id: {
                  description: "Microsoft Entra tenant ID",
                  isRequired: true,
                  // No default!
                },
              },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("can't be auto-filled");
      expect(result.reason).toContain("tenant_id");
    });

    it("rejects Smithery-only headers (non-user-configurable auth)", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.smithery-auth",
          description: "Smithery auth server",
          version: "1.0.0",
          remotes: [
            {
              type: "streamable-http",
              url: "https://smithery.example.com/mcp",
              headers: [
                {
                  name: "Authorization",
                  description: "Smithery API token",
                  value: "Bearer sk-12345",
                },
              ],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("Smithery authentication");
      expect(result.reason).toContain("manual configuration");
    });

    it("rejects npm with non-stdio transport", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.npm-sse",
          description: "NPM with SSE transport",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/npm-sse",
              version: "1.0.0",
              transport: { type: "sse" }, // Non-stdio transport
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("unsupported transport");
    });

    it("rejects MCPB-only packages", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.mcpb-only",
          description: "MCPB-only server",
          version: "1.0.0",
          packages: [
            {
              registryType: "mcpb",
              identifier: "mcpb-only",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("transport is not supported");
    });

    it("rejects streamable-http with multiple unresolved variables", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.multi-unresolved",
          description: "Multiple unresolved vars",
          version: "1.0.0",
          remotes: [
            {
              type: "streamable-http",
              url: "https://{env}.{tenant}.example.com/mcp",
              variables: {
                env: { description: "Environment (prod/staging)", isRequired: true },
                tenant: { description: "Tenant ID", isRequired: true },
              },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("can't be auto-filled");
    });

    it("rejects when only optional URL variables without defaults remain", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.optional-unresolved",
          description: "Optional var without default",
          version: "1.0.0",
          remotes: [
            {
              type: "streamable-http",
              url: "https://example.com/{optional_path}/mcp",
              variables: {
                optional_path: {
                  description: "Optional path segment",
                  isRequired: false,
                  // No default - this creates an unresolved template
                },
              },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("can't be auto-filled");
    });

    it("rejects Smithery headers even with other valid transports", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.smithery-http",
          description: "HTTP with Smithery headers",
          version: "1.0.0",
          remotes: [
            {
              type: "streamable-http",
              url: "https://example.com/mcp",
              headers: [
                { name: "X-API-Key", value: "preconfigured-secret" },
                { name: "X-Client-Id", value: "preconfigured-id" },
              ],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("Smithery authentication");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EDGE CASES
  // ─────────────────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles server name without slashes (uses full name as display name)", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "simple-server",
          description: "Simple named server",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "simple-server",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.id).toBe("simple-server");
      expect(result.entry.name).toBe("simple-server");
    });

    it("handles environment variables with empty environmentVariables array", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.empty-env",
          description: "Empty env array",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/empty-env",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.requiredConfig).toBeUndefined();
      expect(result.entry.configTemplate.env).toBeUndefined();
      expect(result.linkProvider).toBeUndefined();
    });

    it("handles multiple environment variables with mixed required/optional", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.mixed-env",
          description: "Mixed env vars",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/mixed-env",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [
                { name: "REQ1", description: "Required 1", isRequired: true },
                { name: "OPT1", description: "Optional 1", isRequired: false },
                { name: "REQ2", description: "Required 2", isRequired: true },
                { name: "OPT2", description: "Optional 2", isRequired: false },
              ],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.requiredConfig).toHaveLength(2);
      expect(result.entry.configTemplate.env).toEqual({
        REQ1: { from: "link", provider: "io-example-mixed-env", key: "REQ1" },
        OPT1: { from: "link", provider: "io-example-mixed-env", key: "OPT1" },
        REQ2: { from: "link", provider: "io-example-mixed-env", key: "REQ2" },
        OPT2: { from: "link", provider: "io-example-mixed-env", key: "OPT2" },
      });
      expect(result.linkProvider).toEqual({
        type: "apikey",
        id: "io-example-mixed-env",
        displayName: "io.example.mixed-env",
        description: "Mixed env vars",
        secretSchema: { REQ1: "string", OPT1: "string", REQ2: "string", OPT2: "string" },
      });
    });

    it("handles URL with multiple substituted variables", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.multi-substitute",
          description: "Multiple var substitution",
          version: "1.0.0",
          remotes: [
            {
              type: "streamable-http",
              url: "https://{region}-{env}.example.com/{version}/mcp",
              variables: {
                region: { description: "Region", isRequired: true, default: "us" },
                env: { description: "Environment", isRequired: true, default: "prod" },
                version: { description: "API version", isRequired: true, default: "v1" },
              },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.configTemplate.transport).toEqual({
        type: "http",
        url: "https://us-prod.example.com/v1/mcp",
      });
    });

    it("handles empty description field", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.no-desc",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/no-desc",
              version: "1.0.0",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.entry.description).toBeUndefined();
    });

    it("handles environment variable with choices (ignored in v1)", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.choices",
          description: "With choices",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/choices",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [
                {
                  name: "REGION",
                  description: "AWS Region",
                  isRequired: true,
                  choices: ["us-east-1", "us-west-2", "eu-west-1"],
                },
              ],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      // Choices are ignored in v1 per design doc
      expect(result.entry.requiredConfig?.[0]?.examples).toBeUndefined();

      expect(result.entry.configTemplate.env).toEqual({
        REGION: { from: "link", provider: "io-example-choices", key: "REGION" },
      });
      expect(result.linkProvider).toEqual({
        type: "apikey",
        id: "io-example-choices",
        displayName: "io.example.choices",
        description: "With choices",
        secretSchema: { REGION: "string" },
      });
    });

    it("handles environment variable with isSecret (ignored in v1)", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.secret",
          description: "With secret",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/secret",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [
                {
                  name: "SECRET_KEY",
                  description: "Secret API key",
                  isRequired: true,
                  isSecret: true,
                },
              ],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      // isSecret is not mapped in v1 per design doc
      expect(result.entry.requiredConfig?.[0]).not.toHaveProperty("isSecret");

      expect(result.entry.configTemplate.env).toEqual({
        SECRET_KEY: { from: "link", provider: "io-example-secret", key: "SECRET_KEY" },
      });
      expect(result.linkProvider).toEqual({
        type: "apikey",
        id: "io-example-secret",
        displayName: "io.example.secret",
        description: "With secret",
        secretSchema: { SECRET_KEY: "string" },
      });
    });

    it("handles environment variable with format (ignored in v1)", ({ expect }) => {
      const fixture: UpstreamServerEntry = {
        server: {
          $schema: "https://example.com/schema.json",
          name: "io.example.format",
          description: "With format",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/format",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [
                { name: "EMAIL", description: "Email address", isRequired: true, format: "email" },
              ],
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            statusChangedAt: "2025-01-01T00:00:00.000000Z",
            publishedAt: "2025-01-01T00:00:00.000000Z",
            updatedAt: "2025-01-01T00:00:00.000000Z",
            isLatest: true,
          },
        },
      };

      const result = translate(fixture);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      // format is ignored in v1 per design doc
      expect(result.entry.requiredConfig?.[0]).not.toHaveProperty("format");

      expect(result.entry.configTemplate.env).toEqual({
        EMAIL: { from: "link", provider: "io-example-format", key: "EMAIL" },
      });
      expect(result.linkProvider).toEqual({
        type: "apikey",
        id: "io-example-format",
        displayName: "io.example.format",
        description: "With format",
        secretSchema: { EMAIL: "string" },
      });
    });
  });
});
