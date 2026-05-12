/**
 * Bundled atlas agent discovery — list / describe.
 *
 * Distinct from `bundled-agent-tools.ts` which creates the per-id
 * `agent_<id>` callable wrappers. These tools surface the catalog of
 * bundled agents themselves (web, gh, slack, etc.) with their input
 * schema + constraints + examples so the chat can pick which one to
 * invoke without fishing through `list_capabilities`.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { bundledAgents, discoverableBundledAgents } from "@atlas/bundled-agents";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

interface BundledAgentSummary {
  id: string;
  description: string;
  examples: string[];
  constraints?: string;
}

function summarize(agent: (typeof bundledAgents)[number]): BundledAgentSummary {
  const { metadata } = agent;
  return {
    id: metadata.id,
    description: metadata.description,
    examples: metadata.expertise?.examples ?? [],
    ...(metadata.constraints ? { constraints: metadata.constraints } : {}),
  };
}

export function createListBundledAgentsTool(logger: Logger): AtlasTools {
  return {
    list_bundled_agents: tool({
      description:
        "List the bundled atlas agents available on this platform — web, gh, slack, summary, etc. " +
        "Each entry carries id + description + examples + constraints. Bundled agents are " +
        "zero-config (the runtime auto-wires their tools and credentials) and are the default " +
        "for any task that fits their domain. To inspect input/output schemas, follow up with " +
        "`describe_bundled_agent(id)` — and to actually invoke, call `agent_<id>` or `delegate`.",
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
        const agents = discoverableBundledAgents
          .map(summarize)
          .sort((a, b) => a.id.localeCompare(b.id));
        logger.info("list_bundled_agents succeeded", { count: agents.length });
        return { ok: true as const, agents, count: agents.length };
      },
    }),
  };
}

function serializeSchema(schema: unknown): unknown {
  if (schema == null) return undefined;
  if (typeof schema === "object" && schema !== null && "_zod" in schema) {
    try {
      return z.toJSONSchema(schema as z.ZodType);
    } catch {
      return undefined;
    }
  }
  return schema;
}

export function createDescribeBundledAgentTool(logger: Logger): AtlasTools {
  return {
    describe_bundled_agent: tool({
      description:
        "Return the full metadata for a single bundled atlas agent — id, description, examples, " +
        "constraints, and inputSchema/outputSchema. The schemas are load-bearing for correct " +
        "invocation (the AI SDK validates against them), so this is the cheaper inspection step " +
        "before reaching for `delegate` or `agent_<id>`.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Bundled agent id, e.g. 'web', 'gh', 'slack'."),
      }),
      execute: async ({ id }) => {
        await Promise.resolve();
        const agent = bundledAgents.find((a) => a.metadata.id === id);
        if (!agent) {
          return {
            ok: false as const,
            error: `Bundled agent "${id}" not found. Use list_bundled_agents to see valid ids.`,
          };
        }
        const { metadata } = agent;
        logger.info("describe_bundled_agent succeeded", { id });
        return {
          ok: true as const,
          agent: {
            id: metadata.id,
            description: metadata.description,
            examples: metadata.expertise?.examples ?? [],
            ...(metadata.constraints ? { constraints: metadata.constraints } : {}),
            inputSchema: serializeSchema(metadata.inputSchema),
            outputSchema: serializeSchema(metadata.outputSchema),
          },
        };
      },
    }),
  };
}
