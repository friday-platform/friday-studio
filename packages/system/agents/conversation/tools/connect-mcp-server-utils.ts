/** Template hydration and blessed-registry matching for MCP servers. */

import type { MCPServerMetadata } from "@atlas/core";
import type { DynamicProviderInput } from "@atlas/link";

/**
 * Result of a blessed registry check.
 * Returns server info if found, null otherwise.
 */
export type BlessedMatch = {
  id: string;
  name: string;
  authType: "oauth" | "apikey" | "none";
  requiredConfig?: Array<{ key: string; description: string }>;
};

/**
 * Values extracted by LLM, passed to template hydrators.
 */
export type ExtractedValues = {
  id: string;
  name: string;
  description: string;
  url?: string;
  command?: string;
  args?: string[];
  tokenEnvVar?: string;
};

/**
 * Result of template hydration.
 * Registry entry goes to MCP registry, provider goes to Link (if auth needed).
 */
export type HydratedConfig = {
  registry: Omit<MCPServerMetadata, "source" | "securityRating">;
  provider: DynamicProviderInput | null;
};

/**
 * Convert MCPServerMetadata to BlessedMatch.
 * Infers auth type from config structure.
 */
function toBlessedMatch(server: MCPServerMetadata): BlessedMatch {
  let authType: "oauth" | "apikey" | "none" = "none";

  const auth = server.configTemplate.auth;
  const env = server.configTemplate.env;

  if (auth?.type === "bearer" && auth.token_env && env) {
    const envValue = env[auth.token_env];
    if (
      typeof envValue === "object" &&
      envValue !== null &&
      "from" in envValue &&
      envValue.from === "link" &&
      "key" in envValue &&
      typeof envValue.key === "string"
    ) {
      authType = envValue.key === "access_token" ? "oauth" : "apikey";
    }
  } else if (server.requiredConfig?.length) {
    authType = "apikey";
  }

  return {
    id: server.id,
    name: server.name,
    authType,
    requiredConfig: server.requiredConfig?.map((c) => ({ key: c.key, description: c.description })),
  };
}

/**
 * Generates standardized environment variable key from server ID.
 * "google-calendar" -> "GOOGLE_CALENDAR"
 */
function toEnvKey(id: string, suffix: string): string {
  return `${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

/**
 * Template hydration functions.
 * Each template knows how to build registry + provider from extracted values.
 *
 * Design notes:
 * - http-oauth: Uses OAuth discovery mode, generates Link reference for access_token
 * - http-apikey: Uses bearer auth with API key from Link
 * - http-none: No auth (local/dev servers)
 * - stdio-apikey: CLI command with env var from Link
 * - stdio-none: CLI command with no auth (utilities)
 */

/**
 * Build registry entry with common fields. Templates only specify what varies.
 */
function buildRegistry(
  v: ExtractedValues,
  configTemplate: HydratedConfig["registry"]["configTemplate"],
  requiredConfig?: HydratedConfig["registry"]["requiredConfig"],
): HydratedConfig["registry"] {
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    configTemplate,
    ...(requiredConfig && { requiredConfig }),
  };
}

/**
 * Build API key provider (reused by http-apikey and stdio-apikey).
 */
function buildApiKeyProvider(v: ExtractedValues): DynamicProviderInput {
  return {
    type: "apikey",
    id: v.id,
    displayName: v.name,
    description: v.description,
    secretSchema: { api_key: "string" },
  };
}

/**
 * Assert URL exists (required for http-* templates).
 * Throws with clear message if template is misconfigured.
 */
function requireUrl(v: ExtractedValues): string {
  if (!v.url) throw new Error(`HTTP template requires URL but none provided for ${v.id}`);
  return v.url;
}

/**
 * Assert command exists (required for stdio-* templates).
 * Throws with clear message if template is misconfigured.
 */
function requireCommand(v: ExtractedValues): string {
  if (!v.command) throw new Error(`stdio template requires command but none provided for ${v.id}`);
  return v.command;
}

type TemplateKey = "http-oauth" | "http-apikey" | "http-none" | "stdio-apikey" | "stdio-none";

export const CONFIG_TEMPLATES: Record<TemplateKey, (v: ExtractedValues) => HydratedConfig> = {
  "http-oauth": (v) => {
    const url = requireUrl(v);
    const envKey = toEnvKey(v.id, "ACCESS_TOKEN");
    return {
      registry: buildRegistry(
        v,
        {
          transport: { type: "http", url },
          auth: { type: "bearer", token_env: envKey },
          env: { [envKey]: { from: "link", provider: v.id, key: "access_token" } },
        },
        [{ key: envKey, description: `${v.name} access token from Link`, type: "string" as const }],
      ),
      provider: {
        type: "oauth",
        id: v.id,
        displayName: v.name,
        description: v.description,
        oauthConfig: { mode: "discovery", serverUrl: url },
      },
    };
  },

  "http-apikey": (v) => {
    const url = requireUrl(v);
    const envKey = v.tokenEnvVar || toEnvKey(v.id, "API_KEY");
    return {
      registry: buildRegistry(
        v,
        {
          transport: { type: "http", url },
          auth: { type: "bearer", token_env: envKey },
          env: { [envKey]: { from: "link", provider: v.id, key: "api_key" } },
        },
        [{ key: envKey, description: `${v.name} API key`, type: "string" as const }],
      ),
      provider: buildApiKeyProvider(v),
    };
  },

  "http-none": (v) => ({
    registry: buildRegistry(v, { transport: { type: "http", url: requireUrl(v) } }),
    provider: null,
  }),

  "stdio-apikey": (v) => {
    const command = requireCommand(v);
    const envKey = v.tokenEnvVar || toEnvKey(v.id, "API_KEY");
    return {
      registry: buildRegistry(
        v,
        {
          transport: { type: "stdio", command, args: v.args },
          env: { [envKey]: { from: "link", provider: v.id, key: "api_key" } },
        },
        [{ key: envKey, description: `${v.name} API key`, type: "string" as const }],
      ),
      provider: buildApiKeyProvider(v),
    };
  },

  "stdio-none": (v) => ({
    registry: buildRegistry(v, {
      transport: { type: "stdio", command: requireCommand(v), args: v.args },
    }),
    provider: null,
  }),
};

/**
 * Check if input mentions a blessed (known) MCP server.
 *
 * Only matches URLs - this is a high-confidence fast-path. When a URL matches,
 * we can skip LLM extraction entirely. For natural language like "add Linear",
 * we intentionally fall through to LLM extraction to avoid false positives
 * (e.g., "linear workflow" matching the Linear service).
 *
 * @param input - User's natural language input
 * @param servers - The MCP servers registry to check against
 * @returns Match info if found, null otherwise
 */
export function checkBlessedRegistry(
  input: string,
  servers: Record<string, MCPServerMetadata>,
): BlessedMatch | null {
  const lowerInput = input.toLowerCase();

  // URL match only (highest confidence, no false positives)
  for (const server of Object.values(servers)) {
    const transport = server.configTemplate.transport;
    if (transport.type === "http" && transport.url) {
      if (lowerInput.includes(transport.url.toLowerCase())) {
        return toBlessedMatch(server);
      }
    }
  }

  return null;
}
