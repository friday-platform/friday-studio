/** Error thrown when an MCP HTTP server fails to start up. */
export class MCPStartupError extends Error {
  constructor(
    public readonly kind: "spawn" | "timeout" | "connect",
    public readonly serverId: string,
    public readonly command?: string,
    override readonly cause?: unknown,
  ) {
    super(`MCP server "${serverId}" startup failed (${kind})${command ? `: ${command}` : ""}`);
    this.name = "MCPStartupError";
  }
}

/** Error thrown when an MCP HTTP server rejects authentication (401). */
export class MCPAuthError extends Error {
  constructor(
    public readonly serverId: string,
    public readonly url: string,
    message: string,
  ) {
    super(`MCP server "${serverId}" authentication failed (${url}): ${message}`);
    this.name = "MCPAuthError";
  }
}
