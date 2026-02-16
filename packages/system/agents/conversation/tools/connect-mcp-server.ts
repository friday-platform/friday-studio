import { client, parseResult } from "@atlas/client/v2";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { registry } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { generateObject, tool } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { z } from "zod";
// Import pure utils (extracted to avoid circular deps in tests)
import {
  type BlessedMatch,
  CONFIG_TEMPLATES,
  checkBlessedRegistry as checkBlessedRegistryWithServers,
  type HydratedConfig,
} from "./connect-mcp-server-utils.ts";

/**
 * Template identifiers for MCP server configuration patterns.
 * LLM selects one based on transport and auth signals in user input.
 */
const TemplateEnum = z.enum([
  "http-oauth", // HTTP + OAuth discovery (SSO, workspace apps)
  "http-apikey", // HTTP + Bearer token
  "http-none", // HTTP + no auth (local/dev)
  "stdio-apikey", // CLI + env var auth
  "stdio-none", // CLI + no auth (utilities)
]);

/**
 * LLM output schema for extracting MCP server info.
 * Uses discriminated union for success/failure to enable type-safe handling.
 */
const LLMExtractionResultSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    template: TemplateEnum,
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(64)
      .describe("Kebab-case server ID"),
    name: z.string().min(1).max(100).describe("Human-readable display name"),
    description: z.string().min(1).max(200).describe("One-sentence description"),
    domains: z.array(z.string().min(1).max(50)).min(1).max(10).describe("1-10 keyword domains"),
    // Transport-specific (conditionally required based on template)
    url: z.httpUrl().optional().describe("HTTP endpoint URL"),
    command: z.string().optional().describe("CLI command (e.g., npx, uvx)"),
    args: z.array(z.string()).optional().describe("CLI arguments"),
    // Auth-specific
    tokenEnvVar: z.string().optional().describe("Env var name for token, not the value"),
  }),
  z.object({
    success: z.literal(false),
    error: z.string().describe("Why extraction failed"),
    missingInfo: z.array(z.string()).describe("What additional info is needed"),
  }),
]);

/**
 * Check if input mentions a blessed (known) MCP server.
 * Wraps the pure function with the global registry.
 */
function checkBlessedRegistry(input: string): BlessedMatch | null {
  return checkBlessedRegistryWithServers(input, mcpServersRegistry.servers);
}

const EXTRACTION_PROMPT = `You extract MCP server connection info from user input.

## Input Types
- JSON config (parse directly)
- URL (HTTP endpoint)
- CLI command (npx, uvx, docker)
- Natural language description

## Extract
1. **template**: Pick ONE from [http-oauth, http-apikey, http-none, stdio-apikey, stdio-none]
2. **id**: Kebab-case identifier (max 64 chars)
3. **name**: Human-readable display name
4. **description**: One sentence explaining the server
5. **domains**: 1-5 keyword categories
6. **url**: HTTP endpoint (for http-* templates)
7. **command**: CLI command (for stdio-* templates)
8. **args**: CLI arguments array (for stdio-* templates)
9. **tokenEnvVar**: Environment variable NAME for auth token (not the value)

## Template Selection
- http-oauth: HTTP URL + mentions SSO, OAuth, "sign in", workspace login
- http-apikey: HTTP URL + mentions API key, token, PAT, bearer
- http-none: HTTP URL + localhost, local, dev, no auth, internal
- stdio-apikey: CLI + mentions token, API key, auth required
- stdio-none: CLI + utility tool (time, filesystem), no auth

## Rules
- id: lowercase, hyphens only, max 64 chars
- domains: lowercase keywords like "calendar", "email", "github"
- tokenEnvVar: SCREAMING_CASE (e.g., "ACME_API_KEY")

## FAIL when
- Cannot identify the service (generic URL, no context)
- Input too vague for meaningful extraction
- Contradictory requirements`;

/**
 * Error result from extractAndHydrate when extraction fails.
 */
export type ExtractionError = { error: string; missingInfo: string[] };

/**
 * Extract MCP server info from user input using LLM.
 * Returns hydrated config ready for registry + provider creation.
 *
 * @param input - User's natural language input describing the MCP server
 * @param abortSignal - Optional abort signal for cancellation
 * @returns HydratedConfig on success, ExtractionError on failure
 */
export async function extractAndHydrate(
  input: string,
  abortSignal?: AbortSignal,
): Promise<HydratedConfig | ExtractionError> {
  // LLM extraction
  const result = await generateObject({
    model: wrapAISDKModel(registry.languageModel("groq:openai/gpt-oss-120b")),
    schema: LLMExtractionResultSchema,
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: input },
    ],
    abortSignal,
  }).catch((err) => {
    logger.error("LLM extraction error", { error: err });
    return { error: `LLM extraction failed: ${stringifyError(err)}` };
  });

  // Handle LLM error
  if ("error" in result) {
    return { error: result.error, missingInfo: [] };
  }

  const extracted = result.object;
  if (!extracted.success) {
    return { error: extracted.error, missingInfo: extracted.missingInfo };
  }

  // Validate template-specific requirements
  if (extracted.template.startsWith("http-") && !extracted.url) {
    return { error: "HTTP template requires URL", missingInfo: ["url"] };
  }
  if (extracted.template.startsWith("stdio-") && !extracted.command) {
    return { error: "Stdio template requires command", missingInfo: ["command"] };
  }

  // Hydrate using template
  const hydrate = CONFIG_TEMPLATES[extracted.template];
  if (!hydrate) {
    return { error: `Unknown template: ${extracted.template}`, missingInfo: [] };
  }

  return hydrate({
    id: extracted.id,
    name: extracted.name,
    description: extracted.description,
    domains: extracted.domains,
    url: extracted.url,
    command: extracted.command,
    args: extracted.args,
    tokenEnvVar: extracted.tokenEnvVar,
  });
}

/**
 * Tool for adding MCP servers to the platform.
 *
 * Accepts connection info in any format:
 * - JSON config (server configuration)
 * - URL (HTTP endpoint)
 * - CLI command (npx, uvx, docker)
 * - Natural language description
 *
 * Returns setup instructions or asks for clarification if input is too vague.
 */
export const connectMcpServerTool = tool({
  description:
    "Add a new MCP server to the platform. Accepts connection info in any format (JSON config, URL, or description). Returns setup instructions or asks for clarification if input is too vague.",

  inputSchema: z.object({
    connection_info: z
      .string()
      .describe(
        "MCP server connection info - JSON config, URL, CLI command, or natural language description",
      ),
  }),

  execute: async ({ connection_info }, { abortSignal }) => {
    // 1. Check blessed registry FIRST (fast path, no LLM call)
    const blessedMatch = checkBlessedRegistry(connection_info);
    if (blessedMatch) {
      return {
        success: true,
        server: { id: blessedMatch.id, name: blessedMatch.name },
        provider: null,
        authType: blessedMatch.authType,
        nextSteps: [
          `"${blessedMatch.name}" is registered and available for tasks`,
          ...(blessedMatch.authType !== "none"
            ? [
                `Authentication is required to use this server. Ask the user if they would like to authenticate now.`,
              ]
            : []),
        ],
        isBlessed: true,
      };
    }

    // 2. Extract + hydrate via LLM
    const result = await extractAndHydrate(connection_info, abortSignal);
    if ("error" in result) {
      return {
        success: false,
        error: result.error,
        missingInfo: result.missingInfo,
        stage: "extraction",
        hint: "Please provide more details about this MCP server.",
      };
    }

    // 3. Create Link provider FIRST if auth required (blocking - no provider = useless server)
    let providerCreated: { id: string; type: string } | null = null;
    let providerOwnedByUs = false;
    if (result.provider) {
      // Try creating the provider
      try {
        const providerResult = await parseResult(
          client.link.v1.providers.$post({ json: { provider: result.provider } }),
        );
        if (providerResult.ok && providerResult.data.ok) {
          providerCreated = { id: providerResult.data.provider.id, type: result.provider.type };
          providerOwnedByUs = true;
        }
      } catch {
        // Creation failed — may be a retry after previous orphaned provider
      }

      // If creation didn't succeed, check if provider already exists (idempotent retry)
      if (!providerCreated) {
        try {
          const existingResult = await parseResult(
            client.link.v1.providers[":id"].$get({ param: { id: result.provider.id } }),
          );
          if (existingResult.ok) {
            logger.info("Provider already exists, reusing for registry creation", {
              providerId: result.provider.id,
            });
            providerCreated = { id: result.provider.id, type: result.provider.type };
          }
        } catch {
          // Existence check also failed
        }
      }

      if (!providerCreated) {
        return {
          success: false,
          error: `Cannot set up authentication for "${result.registry.name}"`,
          stage: "provider",
          hint: "The connection service may be unavailable. Please try again later.",
        };
      }
    }

    // 4. Add to MCP registry (only after provider is ready, if auth was required)
    const registryResult = await parseResult(
      client.mcpRegistry.index.$post({
        json: {
          entry: {
            ...result.registry,
            source: "agents" as const,
            securityRating: "unverified" as const,
          },
        },
      }),
    );
    if (!registryResult.ok) {
      // Compensating delete: only remove provider if we created it in this invocation
      if (providerCreated && providerOwnedByUs) {
        try {
          await parseResult(
            client.link.v1.providers[":id"].$delete({ param: { id: providerCreated.id } }),
          );
        } catch (cleanupErr) {
          logger.warn("Failed to clean up orphaned provider", {
            providerId: providerCreated.id,
            error: cleanupErr,
          });
        }
      }

      // Handle 409 collision - daemon returns { error, suggestion }
      const errorParsed = z
        .object({ error: z.string().optional(), suggestion: z.string().optional() })
        .safeParse(registryResult.error);
      if (errorParsed.success && errorParsed.data.suggestion) {
        return {
          success: false,
          error: errorParsed.data.error ?? `Server ID "${result.registry.id}" already exists.`,
          stage: "registry",
          suggestion: errorParsed.data.suggestion,
          hint: `Try using "${errorParsed.data.suggestion}" instead.`,
        };
      }
      return { success: false, error: String(registryResult.error), stage: "registry" };
    }

    // 5. Return success with next steps
    return {
      success: true,
      server: { id: result.registry.id, name: result.registry.name },
      provider: providerCreated,
      authType: result.provider?.type ?? "none",
      nextSteps: [
        `Server "${result.registry.name}" is now available in the MCP registry for tasks`,
        ...(providerCreated
          ? [
              `Authentication is required to use this server. Ask the user if they would like to authenticate now.`,
            ]
          : []),
      ],
      isBlessed: false,
    };
  },
});

// Export the wrapper that uses the global registry (used by evals)
export { checkBlessedRegistry as _checkBlessedRegistry };
