/**
 * Pure string-building helpers for the delegate sub-agent's system
 * prompt. Kept in their own module — with zero imports — so QA evals
 * can `import { ... } from "@atlas/core/delegate/system-prompt"` without
 * pulling in the runtime delegate machinery (streamText, MCP, etc.) and
 * its transitive dependency graph.
 */

/**
 * Tool priority + scope discipline directive injected into every
 * delegate sub-agent's system prompt. The supervisor's prompt
 * (`packages/system/agents/workspace-chat/prompt.txt`) ranks tools
 * 1) direct tools → 2) workspace MCP → 3) agent_* specialists →
 * 4) delegate-without-MCP. That ranking is only in the supervisor's
 * head; the delegate sub-agent runs from a separate system prompt and
 * would otherwise feel free to reach for unrelated agent_* tools or
 * work around MCP failures via run_code / upsert_agent. Restating the
 * ranking here so the sub-agent inherits the same discipline.
 */
export function buildDelegateScopeDirective(mcpServers: readonly string[] | undefined): string {
  return mcpServers && mcpServers.length > 0
    ? `Tool priority for this delegation:\n` +
        `  1. The requested MCP server tool(s) on [${mcpServers.join(", ")}] — your primary path.\n` +
        `  2. \`run_code\` for math, parsing, or reshaping data you already have in this conversation.\n` +
        `  3. Inherited atlas-platform primitives (memory, artifacts, state, webfetch) when the goal requires them.\n\n` +
        `Do NOT escalate past this scope when the primary path fails. Specifically:\n` +
        `  - Do not invoke \`agent_<id>\` tools (e.g. agent_slack, agent_hubspot, agent_web) and ask them to proxy a call that belongs to a different integration. Agents are scoped to their own provider; cross-scope proxying is misuse.\n` +
        `  - Do not call \`upsert_agent\` / \`delete_agent\` / \`begin_draft\` / \`publish_draft\` to spawn temporary agents as a runtime escape hatch. Those are workspace-authoring tools, not retry primitives.\n` +
        `  - Do not use \`run_code\` to curl daemon ports (e.g. http://127.0.0.1:8080 / :3100), read Atlas source files under /Users/.../atlas/, or extract credentials from \`~/.atlas/credentials/**\`. The MCP layer is the supported path; bypassing it produces inconsistent state and burns budget.`
    : `Tool priority for this delegation (no MCP servers requested):\n` +
        `  1. \`run_code\` for math, parsing, or reshaping data you already have.\n` +
        `  2. Inherited atlas-platform primitives (memory, artifacts, state, webfetch).\n` +
        `  3. \`agent_<id>\` specialists only when the goal explicitly requires that integration's expertise.\n\n` +
        `Do not call \`upsert_agent\` / \`delete_agent\` / \`begin_draft\` / \`publish_draft\` — those are workspace-authoring tools, not problem-solving primitives. Do not use \`run_code\` to curl daemon ports, read Atlas source files, or extract credentials from disk.`;
}

/**
 * MCP tool error contract injected into every delegate sub-agent's
 * system prompt. The supervisor returns `reason` to its own LLM, which
 * decides user-facing language; the sub-agent must not paraphrase or
 * translate the upstream error.
 */
export const DELEGATE_MCP_ERROR_CONTRACT = `MCP tool errors: when a tool returns \`{ ok: false, error, phase }\`, call \`finish({ ok: false, reason: error })\` immediately, copying \`error\` byte-for-byte into \`reason\`. The supervisor parses \`reason\` to choose user-facing language — do not paraphrase, translate, compress, or substitute an alternative tool path. If the primary MCP path fails, "the path failed: <error>" IS the answer.`;
