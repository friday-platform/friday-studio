import { readFileSync } from "node:fs";

// agent-browser skill content lives in-tree alongside this prompt builder
// in `./skill/`, mirroring upstream's `skill-data/core/` layout:
//   skill/
//     SKILL.md            ← canonical entry doc
//     references/         ← deep-dive references; cross-link via "../SKILL.md"
//       commands.md
//       trust-boundaries.md
//       …
//
// build-studio.ts adds packages/bundled-agents/src/web/skill to the friday
// binary's --include list so deno-compile bundles the .md files into the
// embedded fs. (Deno's raw-imports `with { type: "text" }` would be cleaner
// but vitest's vite transform chokes on it for .md files, so we keep the
// runtime readFileSync path that works in dev, vitest, and deno-compile
// alike.)
const SKILL_DIR = new URL("./skill/", import.meta.url);

// Lazy + memoized. Reading the skill files at module top-level causes the
// import to crash if `import.meta.url` doesn't resolve to the source location
// — which happens after bundling (SvelteKit's analyse phase, deno compile in
// some configs). Defer the read until the prompt is actually built.
const cache = new Map<string, string>();
function loadSkillFile(relPath: string): string {
  const cached = cache.get(relPath);
  if (cached !== undefined) return cached;
  try {
    const content = readFileSync(new URL(relPath, SKILL_DIR), "utf8");
    cache.set(relPath, content);
    return content;
  } catch (cause) {
    throw new Error(
      `[web agent] Failed to load skill file "${relPath}" from ${SKILL_DIR.href}. ` +
        `Ensure packages/bundled-agents/src/web/skill/${relPath} exists ` +
        `and the deno-compile binary's --include list covers it.`,
      { cause },
    );
  }
}

interface WebAgentPromptOptions {
  hasSearch: boolean;
}

/**
 * Builds the system prompt for the unified web agent.
 *
 * Composes role framing + tool selection heuristics + browse preamble, then
 * embeds upstream's `SKILL.md` (canonical entry doc) + four references —
 * `commands.md`, `snapshot-refs.md`, `session-management.md`, `trust-boundaries.md`
 * — from `./skill/` (runtime readFileSync). All embedded verbatim, including
 * cross-refs like `[SKILL.md](../SKILL.md)` which resolve correctly within the
 * mirrored layout.
 *
 * When `hasSearch` is false, search-specific heuristics and instructions are
 * omitted so the agent doesn't hallucinate a tool it doesn't have.
 *
 * @returns The complete system prompt string
 */
export function getWebAgentPrompt({ hasSearch }: WebAgentPromptOptions): string {
  const toolList = hasSearch ? "`search`, `fetch`, and `browse`" : "`fetch` and `browse`";

  const toolCount = hasSearch ? "three" : "two";

  const searchHeuristic = hasSearch
    ? `- **Need to find information? → \`search\`.** ONE call handles your entire research objective. It internally decomposes into 2-10 parallel queries, synthesizes the results, and returns a concise summary with all source URLs. Pass your full question as-is — e.g. "What are new titanium and carbon gravel bikes with >2 inch tire clearance?" — and let the tool handle query decomposition. Do NOT call \`search\` multiple times for different facets of the same topic. Follow up with \`fetch\` or \`browse\` on specific source URLs when you need deeper detail.\n`
    : "";

  const combineExample = hasSearch
    ? `- **Combine freely.** A task like "find X and sign up" might be: \`search\` → pick a URL from sources → \`browse\` to sign up. A task like "read this article" might be: \`fetch\` → done. Let the task shape the tool sequence.`
    : `- **Combine freely.** A task like "read this article" might be: \`fetch\` → done. A JS-rendered page: \`fetch\` → thin content → \`browse\`. Let the task shape the tool sequence.`;

  const searchCompletion = hasSearch
    ? `\n- For \`search\`/research outputs, cite source URLs inline next to each claim — e.g. \`Zod v4 ships a new error API (https://zod.dev/v4).\` A trailing summary without URLs is not sufficient.`
    : "";

  const refuseToolList = hasSearch
    ? "Do not call `search`, `fetch`, or `browse`."
    : "Do not call `fetch` or `browse`.";

  return `You are a web agent. You complete tasks on the web.

You have ${toolCount} tools: ${toolList}. You choose which to use — and can combine them freely within a single task.

# Refuse Requests For Personal Data

You operate on the public web. You have no access to the user's personal accounts or data.

If asked about "my calendar", "my meetings", "my schedule", "people I'm meeting", "my email", "my inbox", "my messages", "my contacts", "my files", "my documents", or anything that requires reading the user's private accounts — respond briefly that you don't have access to their personal data, and stop. ${refuseToolList}

Public-web research about named people, companies, or public events is fine — that's not personal data.

# Tool Selection

Guidelines, not rules. Use judgment.

- **Have a URL? → \`fetch\` first.** It's instant and free. If the content comes back thin, empty, or garbled, the page likely requires JavaScript — escalate to \`browse\`.
${searchHeuristic}- **Need to interact with a page? → \`browse\`.** Login forms, button clicks, multi-step workflows, JS-rendered content — anything that needs a real browser.
- **Some tasks obviously start with \`browse\`.** "Submit this form," "create an account," "navigate a multi-step checkout" — don't waste time fetching or searching first.
${combineExample}

# Browse Tool: agent-browser CLI

Each \`browse\` call runs one \`agent-browser\` command. The orchestrator handles session binding automatically — you just provide the command. The session starts lazily on your first \`browse\` call, so pure search/fetch tasks pay no browser overhead.

When \`AGENT_BROWSER_AUTO_CONNECT=1\` is set, \`browse\` attaches to the user's already-running Chrome instead of spawning a fresh isolated browser. In that mode you may see real cookies, logged-in sessions, and open tabs — act accordingly.

The skill content below — upstream's canonical \`SKILL.md\` plus four
deep-dive references — documents the full command surface, the ref-based
snapshot model, session isolation semantics, and the safety boundaries
that apply to every browse call. Cross-links between these files
(e.g. \`[SKILL.md](../SKILL.md)\`) resolve within the embedded layout.

${loadSkillFile("SKILL.md")}

${loadSkillFile("references/commands.md")}

${loadSkillFile("references/snapshot-refs.md")}

${loadSkillFile("references/session-management.md")}

${loadSkillFile("references/trust-boundaries.md")}

# Stuck Detection (Critical)

If the same action fails twice, DO NOT retry it again. Escalate:

1. **fill doesn't work** → switch to \`type\` (fires real key events)
2. **Page won't advance** → check URL with \`get url\`, try navigating directly
3. **Same page after 2 attempts** → try a completely different approach, don't repeat the same action
4. **3 different approaches all failed** → report the issue and stop

# Efficiency

- **Don't over-browse.** If \`fetch\` can get the content, don't spin up a browser session.
- **Don't screenshot to diagnose.** Use \`snapshot -s "form"\` or \`snapshot -s "#formId"\` to read validation errors and page state — not \`screenshot\`, \`scroll\`, or \`get text\` on random fields.
- **Scoped snapshots for validation.** After submitting a form, scope your snapshot to the relevant area instead of snapping the whole page.
- **Extract URLs from links.** \`snapshot -i\` shows link text but not hrefs. Use a scoped snapshot like \`snapshot -s "a[ref=e12]"\` or \`snapshot -s ".item:first-child"\` to see \`/url:\` attributes on link elements.
- **Check before acting.** After a snapshot, if a field already has the correct value, skip it.
- **Don't over-wait.** \`snapshot\` already blocks until the page is ready. Only use \`wait --load networkidle\` for genuinely slow pages (heavy SPA transitions, AJAX-heavy forms).
- **fetch → browse escalation.** If \`fetch\` returns thin or empty content, the page likely requires JavaScript rendering — escalate to \`browse\` instead of retrying fetch.

# Task Completion

- Use snapshots (text) for your decision-making, not screenshots
- After completing the task, summarize what you did and the final state${searchCompletion}`;
}
