/**
 * Connect MCP Server — Template Selection eval.
 *
 * Tests that extractAndHydrate correctly classifies user input into the
 * right MCP server template (http-oauth, http-apikey, http-none,
 * stdio-apikey, stdio-none) or returns an error for vague inputs.
 */

import { createPlatformModels } from "@atlas/llm";
import { extractAndHydrate } from "@atlas/system/agents/conversation/tools/connect-mcp-server";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";

await loadCredentials();

const platformModels = createPlatformModels(null);

const adapter = new AgentContextAdapter();

interface TemplateCase extends BaseEvalCase {
  expected: string;
}

const cases: TemplateCase[] = [
  // HTTP + OAuth (SSO indicators)
  {
    id: "http-oauth-sso",
    name: "HTTP OAuth - SSO indicator",
    input: "https://mcp.someservice.com/mcp with SSO login",
    expected: "HTTP URL + SSO/OAuth mentioned -> template: http-oauth",
  },
  {
    id: "http-oauth-explicit",
    name: "HTTP OAuth - explicit OAuth",
    input: "Connect to https://api.acme.com/mcp - uses OAuth for authentication",
    expected: "HTTP URL + OAuth mentioned -> template: http-oauth",
  },
  // HTTP + API Key
  {
    id: "http-apikey-explicit",
    name: "HTTP API key - explicit",
    input: "https://api.service.com/mcp with API key authentication",
    expected: "HTTP URL + API key mentioned -> template: http-apikey",
  },
  {
    id: "http-apikey-bearer",
    name: "HTTP API key - bearer token",
    input: "Use https://mcp.example.com with bearer token EXAMPLE_TOKEN",
    expected: "HTTP URL + bearer/token mentioned -> template: http-apikey",
  },
  // HTTP + No Auth
  {
    id: "http-none-internal",
    name: "HTTP no auth - internal server",
    input: "https://mcp.dev.internal.acme.com/mcp - internal server, no auth needed",
    expected: "HTTP URL + internal/no auth -> template: http-none",
  },
  {
    id: "http-none-vpn",
    name: "HTTP no auth - VPN",
    input: "Internal MCP server at https://tools.corp.example.com/mcp behind our VPN",
    expected: "HTTP URL + internal/corporate -> template: http-none",
  },
  // Stdio + API Key
  {
    id: "stdio-apikey-token-flag",
    name: "stdio API key - token flag",
    input: "npx @acme/mcp-server --token required",
    expected: "CLI command + token/auth mentioned -> template: stdio-apikey",
  },
  {
    id: "stdio-apikey-env-var",
    name: "stdio API key - env var",
    input: "uvx acme-mcp with ACME_API_KEY environment variable",
    expected: "CLI command + env var for auth -> template: stdio-apikey",
  },
  // Stdio + No Auth
  {
    id: "stdio-none-time",
    name: "stdio no auth - time server",
    input: "npx @modelcontextprotocol/server-time",
    expected: "CLI utility (time) no auth mentioned -> template: stdio-none",
  },
  {
    id: "stdio-none-filesystem",
    name: "stdio no auth - filesystem",
    input: "uvx mcp-server-filesystem --path /tmp",
    expected: "CLI utility (filesystem) no auth mentioned -> template: stdio-none",
  },
  // Should FAIL (too vague)
  {
    id: "error-vague-generic",
    name: "error - vague generic",
    input: "mcp server",
    expected: "Too vague - should return error with missingInfo",
  },
  {
    id: "error-vague-no-service",
    name: "error - no identifiable service",
    input: "connect to the thing",
    expected: "No identifiable service - should return error",
  },
];

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval({
    name: `connect-mcp-server/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (prompt) => {
        const result = await extractAndHydrate(prompt, platformModels);
        if ("error" in result) {
          return { error: result.error };
        }
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
      score: async (result) => {
        const judge = await llmJudge(result, testCase.expected);
        return [judge];
      },
      metadata: { expected: testCase.expected },
    },
  }),
);
