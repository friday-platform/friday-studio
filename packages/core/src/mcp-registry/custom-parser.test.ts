import { describe, expect, it } from "vitest";
import { type ParseResult, parseCustomMCPConfig } from "./custom-parser.ts";

/**
 * Type guard for successful parse result.
 */
function isSuccess(
  result: ParseResult,
): result is {
  success: true;
  transport: { type: "stdio"; command: string; args: string[] } | { type: "http"; url: string };
  envVars: Array<{ key: string; description?: string; exampleValue?: string }>;
  suggestedName?: string;
} {
  return result.success === true;
}

/**
 * Type guard for failed parse result.
 */
function isFailure(result: ParseResult): result is { success: false; reason: string } {
  return result.success === false;
}

describe("parseCustomMCPConfig", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // SUCCESS CASES
  // ─────────────────────────────────────────────────────────────────────────

  describe("success cases", () => {
    it("parses bare stdio config with command, args, and env", () => {
      const raw = JSON.stringify({
        command: "uvx",
        args: ["spotify-mcp"],
        env: { SPOTIFY_CLIENT_ID: "your_id", SPOTIFY_CLIENT_SECRET: "your_secret" },
      });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.transport).toEqual({ type: "stdio", command: "uvx", args: ["spotify-mcp"] });
      expect(result.envVars).toHaveLength(2);
      expect(result.envVars).toContainEqual({
        key: "SPOTIFY_CLIENT_ID",
        description: "SPOTIFY_CLIENT_ID (e.g. your_id)",
        exampleValue: "your_id",
      });
      expect(result.envVars).toContainEqual({
        key: "SPOTIFY_CLIENT_SECRET",
        description: "SPOTIFY_CLIENT_SECRET (e.g. your_secret)",
        exampleValue: "your_secret",
      });
      expect(result.suggestedName).toBeUndefined();
    });

    it("parses bare stdio config with no args", () => {
      const raw = JSON.stringify({ command: "npx", env: { API_KEY: "test-key" } });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.transport).toEqual({ type: "stdio", command: "npx", args: [] });
      expect(result.envVars).toHaveLength(1);
      expect(result.envVars[0]).toEqual({
        key: "API_KEY",
        description: "API_KEY (e.g. test-key)",
        exampleValue: "test-key",
      });
    });

    it("parses bare http config with url and env", () => {
      const raw = JSON.stringify({
        url: "https://api.example.com/mcp",
        env: { AUTHORIZATION: "Bearer token123" },
      });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.transport).toEqual({ type: "http", url: "https://api.example.com/mcp" });
      expect(result.envVars).toHaveLength(1);
      expect(result.envVars[0]).toEqual({
        key: "AUTHORIZATION",
        description: "AUTHORIZATION (e.g. Bearer token123)",
        exampleValue: "Bearer token123",
      });
    });

    it("parses Claude Desktop wrapper with one server", () => {
      const raw = JSON.stringify({
        mcpServers: {
          "my-server": {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
            env: { ROOT_PATH: "/home/user" },
          },
        },
      });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.transport).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
      });
      expect(result.suggestedName).toBe("my-server");
      expect(result.envVars).toHaveLength(1);
      expect(result.envVars[0]).toEqual({
        key: "ROOT_PATH",
        description: "ROOT_PATH (e.g. /home/user)",
        exampleValue: "/home/user",
      });
    });

    it("returns empty envVars when env is empty object", () => {
      const raw = JSON.stringify({ command: "echo", env: {} });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.envVars).toEqual([]);
    });

    it("returns empty envVars when env is omitted", () => {
      const raw = JSON.stringify({ command: "echo" });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.envVars).toEqual([]);
    });

    it("synthesizes 'Credential: key' description when env value is empty", () => {
      const raw = JSON.stringify({ command: "test", env: { EMPTY_VAR: "" } });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.envVars[0]).toEqual({
        key: "EMPTY_VAR",
        description: "Credential: EMPTY_VAR",
        exampleValue: undefined,
      });
    });

    it("includes real-looking credential values as examples", () => {
      const raw = JSON.stringify({ command: "test", env: { REAL_KEY: "sk-live-abc123" } });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.envVars[0]?.exampleValue).toBe("sk-live-abc123");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REJECT CASES
  // ─────────────────────────────────────────────────────────────────────────

  describe("reject cases", () => {
    it("rejects malformed JSON", () => {
      const result = parseCustomMCPConfig("not json");

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("Invalid JSON");
    });

    it("rejects when both command and url are missing", () => {
      const raw = JSON.stringify({ env: { KEY: "val" } });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("command");
      expect(result.reason).toContain("url");
    });

    it("rejects headers field with instructions to use env", () => {
      const raw = JSON.stringify({
        url: "https://api.example.com",
        headers: { Authorization: "Bearer token" },
      });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("env");
      expect(result.reason).toContain("headers");
      expect(result.reason).toContain('"url"');
      expect(result.reason).toContain('"env"');
    });

    it("rejects sse transport", () => {
      const raw = JSON.stringify({ url: "https://api.example.com/sse", transport: "sse" });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("SSE");
      expect(result.reason).toContain("not supported");
    });

    it("rejects multiple servers in Claude Desktop wrapper", () => {
      const raw = JSON.stringify({
        mcpServers: { serverA: { command: "echo" }, serverB: { command: "cat" } },
      });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("Paste one server at a time");
      expect(result.reason).toContain("serverA");
      expect(result.reason).toContain("serverB");
    });

    it("rejects when mcpServers is empty object", () => {
      const raw = JSON.stringify({ mcpServers: {} });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("command");
      expect(result.reason).toContain("url");
    });

    it("rejects nested mcpServers with no valid server", () => {
      const raw = JSON.stringify({ mcpServers: { broken: { headers: { X: "y" } } } });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(false);
      if (!isFailure(result)) return;
      expect(result.reason).toContain("headers");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EDGE CASES
  // ─────────────────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles env values that are numbers by coercing to string", () => {
      const raw = JSON.stringify({ command: "test", env: { PORT: 8080 } });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.envVars[0]).toEqual({
        key: "PORT",
        description: "PORT (e.g. 8080)",
        exampleValue: "8080",
      });
    });

    it("ignores extra fields in bare config", () => {
      const raw = JSON.stringify({
        command: "echo",
        args: ["hello"],
        env: {},
        description: "My server",
      });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.transport).toEqual({ type: "stdio", command: "echo", args: ["hello"] });
    });

    it("handles top-level url without env", () => {
      const raw = JSON.stringify({ url: "https://mcp.linear.app/mcp" });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.transport).toEqual({ type: "http", url: "https://mcp.linear.app/mcp" });
      expect(result.envVars).toEqual([]);
    });

    it("handles top-level command without args or env", () => {
      const raw = JSON.stringify({ command: "npx" });

      const result = parseCustomMCPConfig(raw);

      expect(result.success).toBe(true);
      if (!isSuccess(result)) return;

      expect(result.transport).toEqual({ type: "stdio", command: "npx", args: [] });
      expect(result.envVars).toEqual([]);
    });
  });
});
