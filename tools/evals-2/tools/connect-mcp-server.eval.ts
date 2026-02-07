import { evalite } from "evalite";
import { extractAndHydrate } from "../../../packages/system/agents/conversation/tools/connect-mcp-server.ts";
import { formatDuration, getTraceDuration } from "../lib/columns.ts";
import { LLMJudge } from "../lib/llm-judge.ts";
import { loadCredentials } from "../lib/load-credentials.ts";

await loadCredentials();

// ============================================================================
// Template Selection Eval (LLM-BASED - appropriate)
// ============================================================================

/**
 * Test LLM template selection accuracy.
 *
 * This eval uses LLMJudge because:
 * - extractAndHydrate calls an LLM for template selection
 * - Template selection is inherently fuzzy (natural language -> template)
 * - Expected outputs are semantic descriptions, not exact values
 */
evalite<{ input: string }, { template: string; id: string } | { error: string }, string>(
  "Connect MCP Server - Template Selection",
  {
    data: [
      // HTTP + OAuth (SSO indicators)
      {
        input: { input: "https://mcp.someservice.com/mcp with SSO login" },
        expected: "HTTP URL + SSO/OAuth mentioned -> template: http-oauth",
      },
      {
        input: { input: "Connect to https://api.acme.com/mcp - uses OAuth for authentication" },
        expected: "HTTP URL + OAuth mentioned -> template: http-oauth",
      },

      // HTTP + API Key
      {
        input: { input: "https://api.service.com/mcp with API key authentication" },
        expected: "HTTP URL + API key mentioned -> template: http-apikey",
      },
      {
        input: { input: "Use https://mcp.example.com with bearer token EXAMPLE_TOKEN" },
        expected: "HTTP URL + bearer/token mentioned -> template: http-apikey",
      },

      // HTTP + No Auth
      {
        input: { input: "https://mcp.dev.internal.acme.com/mcp - internal server, no auth needed" },
        expected: "HTTP URL + internal/no auth -> template: http-none",
      },
      {
        input: {
          input: "Internal MCP server at https://tools.corp.example.com/mcp behind our VPN",
        },
        expected: "HTTP URL + internal/corporate -> template: http-none",
      },

      // Stdio + API Key
      {
        input: { input: "npx @acme/mcp-server --token required" },
        expected: "CLI command + token/auth mentioned -> template: stdio-apikey",
      },
      {
        input: { input: "uvx acme-mcp with ACME_API_KEY environment variable" },
        expected: "CLI command + env var for auth -> template: stdio-apikey",
      },

      // Stdio + No Auth
      {
        input: { input: "npx @modelcontextprotocol/server-time" },
        expected: "CLI utility (time) no auth mentioned -> template: stdio-none",
      },
      {
        input: { input: "uvx mcp-server-filesystem --path /tmp" },
        expected: "CLI utility (filesystem) no auth mentioned -> template: stdio-none",
      },

      // Should FAIL (too vague)
      {
        input: { input: "mcp server" },
        expected: "Too vague - should return error with missingInfo",
      },
      {
        input: { input: "connect to the thing" },
        expected: "No identifiable service - should return error",
      },
    ],
    task: async ({ input }) => {
      const result = await extractAndHydrate(input);
      if ("error" in result) {
        return { error: result.error };
      }

      // Infer template from hydrated config
      const transport = result.registry.configTemplate.transport;
      const hasProvider = result.provider !== null;

      let template: string;
      if (transport.type === "http") {
        if (!hasProvider) {
          template = "http-none";
        } else if (result.provider?.type === "oauth") {
          template = "http-oauth";
        } else {
          template = "http-apikey";
        }
      } else {
        template = hasProvider ? "stdio-apikey" : "stdio-none";
      }

      return { template, id: result.registry.id };
    },
    scorers: [LLMJudge],
    columns: ({ input, output, traces }) => [
      {
        label: "Input",
        value: input?.input
          ? input.input.slice(0, 40) + (input.input.length > 40 ? "..." : "")
          : "-",
      },
      {
        label: "Result",
        value:
          output && "error" in output
            ? `ERROR: ${String(output.error ?? "").slice(0, 30)}`
            : (output?.template ?? "-"),
      },
      { label: "ID", value: output && "id" in output ? output.id : "-" },
      { label: "Time", value: formatDuration(getTraceDuration(traces ?? [])) },
    ],
  },
);
