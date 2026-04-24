/**
 * Client-side custom MCP config JSON parser.
 *
 * Parses raw JSON blobs pasted by users into a structured config shape
 * suitable for the `POST /api/mcp-registry/custom` endpoint.
 *
 * Supported shapes:
 * - Bare stdio: `{ command, args?, env? }`
 * - Bare http:  `{ url, env? }`
 * - Claude Desktop wrapper: `{ mcpServers: { name: { command, args?, env? } } }`
 *
 * @module
 */

/** Stdio transport parsed from user JSON. */
export type ParsedStdioTransport = { type: "stdio"; command: string; args: string[] };

/** HTTP transport parsed from user JSON. */
export type ParsedHttpTransport = { type: "http"; url: string };

/** Discriminated transport union. */
export type ParsedTransport = ParsedStdioTransport | ParsedHttpTransport;

/** Parsed env var entry with synthetic description. */
export type ParsedEnvVar = { key: string; description?: string; exampleValue?: string };

/** Successful parse result. */
export type ParseSuccess = {
  success: true;
  transport: ParsedTransport;
  envVars: ParsedEnvVar[];
  suggestedName?: string;
};

/** Failed parse result. */
export type ParseError = { success: false; reason: string };

/** Discriminated parse result union. */
export type ParseResult = ParseSuccess | ParseError;

/**
 * Parse a raw JSON string containing a custom MCP server configuration.
 *
 * @param rawJson - The raw JSON string pasted by the user.
 * @returns A {@link ParseResult} containing either the parsed config or an error reason.
 */
export function parseCustomMCPConfig(rawJson: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { success: false, reason: "Invalid JSON. Please provide valid JSON configuration." };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { success: false, reason: "Config must be a JSON object, not an array or primitive." };
  }

  const record = parsed as Record<string, unknown>;

  // ── Claude Desktop wrapper shape ─────────────────────────────────────────
  if ("mcpServers" in record) {
    const mcpServers = record.mcpServers;
    if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
      return { success: false, reason: "`mcpServers` must be an object mapping names to configs." };
    }

    const servers = mcpServers as Record<string, unknown>;
    const names = Object.keys(servers);

    if (names.length === 0) {
      return {
        success: false,
        reason: "Config must include either `command` (stdio) or `url` (http).",
      };
    }

    if (names.length > 1) {
      return { success: false, reason: `Paste one server at a time. Found: ${names.join(", ")}.` };
    }

    const suggestedName = names[0]!;
    const serverConfig = servers[suggestedName];

    if (typeof serverConfig !== "object" || serverConfig === null || Array.isArray(serverConfig)) {
      return { success: false, reason: `Server "${suggestedName}" config must be an object.` };
    }

    const inner = parseBareConfig(serverConfig as Record<string, unknown>);
    if (!inner.success) return inner;

    return { ...inner, suggestedName };
  }

  // ── Bare config shape ────────────────────────────────────────────────────
  return parseBareConfig(record);
}

/**
 * Parse a bare config object (not wrapped in mcpServers).
 */
function parseBareConfig(record: Record<string, unknown>): ParseResult {
  // Reject headers early — instruct user to use env instead
  if ("headers" in record) {
    return {
      success: false,
      reason:
        'Use `env` for credentials instead of `headers`. Example: `{"url":"...","env":{"AUTHORIZATION":"Bearer YOUR_TOKEN"}}`',
    };
  }

  // Reject SSE transport
  if (record.transport === "sse" || record.transport === "SSE") {
    return {
      success: false,
      reason: "SSE is not supported. Use `url` with streamable-http or `command` with stdio.",
    };
  }

  const hasCommand = "command" in record;
  const hasUrl = "url" in record;

  if (!hasCommand && !hasUrl) {
    return {
      success: false,
      reason: "Config must include either `command` (stdio) or `url` (http).",
    };
  }

  // Stdio branch
  if (hasCommand) {
    const command = typeof record.command === "string" ? record.command.trim() : "";
    if (command.length === 0) {
      return { success: false, reason: "`command` must be a non-empty string." };
    }

    const args = parseArgs(record.args);
    const envVars = parseEnvVars(record.env);

    return { success: true, transport: { type: "stdio", command, args }, envVars };
  }

  // HTTP branch
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (url.length === 0 || !URL.canParse(url)) {
    return { success: false, reason: "`url` must be a valid HTTP URL." };
  }

  const envVars = parseEnvVars(record.env);

  return { success: true, transport: { type: "http", url }, envVars };
}

/**
 * Parse the optional `args` field into a string array.
 */
function parseArgs(argsUnknown: unknown): string[] {
  if (argsUnknown === undefined || argsUnknown === null) return [];
  if (Array.isArray(argsUnknown)) {
    return argsUnknown.filter((a): a is string => typeof a === "string");
  }
  return [];
}

/**
 * Parse the optional `env` field into ParsedEnvVar entries.
 *
 * Values are coerced to strings and used as examples only.
 */
function parseEnvVars(envUnknown: unknown): ParsedEnvVar[] {
  if (typeof envUnknown !== "object" || envUnknown === null || Array.isArray(envUnknown)) {
    return [];
  }

  const env = envUnknown as Record<string, unknown>;
  const entries: ParsedEnvVar[] = [];

  for (const [key, value] of Object.entries(env)) {
    const strValue = value === undefined || value === null ? "" : String(value);
    const description = strValue.length > 0 ? `${key} (e.g. ${strValue})` : `Credential: ${key}`;

    entries.push({ key, description, exampleValue: strValue.length > 0 ? strValue : undefined });
  }

  return entries;
}
