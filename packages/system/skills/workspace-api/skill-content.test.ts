import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledAgentsRegistry } from "@atlas/bundled-agents";
import { beforeAll, describe, expect, it } from "vitest";

const SKILL_PATH = fileURLToPath(new URL("./SKILL.md", import.meta.url));

describe("workspace-api SKILL.md content", () => {
  let content = "";

  beforeAll(async () => {
    content = await readFile(SKILL_PATH, "utf8");
  });

  it("does not contain the deprecated 'two agent types' claim", () => {
    expect(content).not.toContain("two agent types");
  });

  it("mentions 'type: atlas' at least three times (cheat sheet, recipe, gotchas)", () => {
    const matches = content.match(/type: atlas/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("references the cross-domain 'list_capabilities' router tool", () => {
    expect(content).toContain("list_capabilities");
  });

  it("references at least one per-domain discovery tool as the workspace inventory primary", () => {
    // The skill positions per-domain list_X tools (list_mcp_servers,
    // list_bundled_agents, list_skills) as the default for inventory
    // questions, with list_capabilities reserved for cross-domain
    // routing. A regression here would mean the recipe is back-pointing
    // at the router for inventory — chat would over-call it and the
    // per-domain assertion in the tool-suite-management eval would
    // start failing intermittently.
    expect(content).toMatch(/list_mcp_servers|list_bundled_agents|list_skills/);
  });
});

/**
 * Bundled-agent reference pinning.
 *
 * Regression: commit 11667073e ("Remove email bundled agent") deleted the
 * `email` bundled agent but left stale `agent: "email"` examples in this
 * skill, in `references/agent-types.md`, in the `list_capabilities` tool
 * description, and in the Gmail MCP `constraints` blurb. The workspace-chat
 * meta-agent followed the still-active guidance and emitted workspaces
 * referencing a non-existent base agent. The atlas-daemon then logged
 * `Base agent not found: email` and silently dropped the agent at
 * registration — an end-user-visible "send email" feature stalled in
 * production with no surfaced error.
 *
 * This test scans every file the workspace-chat LLM is primed by — skill
 * markdown + the discovery tool's description string + the workspace-chat
 * system prompt — and asserts that every literal `agent: "<id>"` reference
 * resolves to a real entry in `bundledAgentsRegistry`. It is the cheapest
 * possible safety net: when a bundled agent is added or removed, this test
 * fails fast and points at the file that needs to be updated.
 */
describe("LLM-priming surfaces only reference real bundled agents", () => {
  // Skills root: every `.md` / `.yml` / `.yaml` under here is loaded by the
  // LLM via `load_skill` (skill markdown + reference docs + asset examples)
  // — so any `agent: "<id>"` reference inside qualifies for the drift check.
  // Globbed rather than hand-listed so adding a new skill or asset can't
  // bypass the test.
  const SKILLS_ROOT = fileURLToPath(new URL("../..", import.meta.url));

  // Files outside the skills tree that still prime the LLM directly: the
  // workspace-chat system prompt and its tool description strings.
  const NON_SKILL_PRIMING_FILES = [
    new URL("../../agents/workspace-chat/prompt.txt", import.meta.url),
    new URL("../../agents/workspace-chat/tools/list-capabilities.ts", import.meta.url),
    new URL("../../agents/workspace-chat/tools/upsert-tools.ts", import.meta.url),
  ].map((u) => fileURLToPath(u));

  async function walkSkills(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await walkSkills(full)));
      } else if (/\.(md|ya?ml)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  // Match `agent: "<id>"`, `agent: '<id>'`, and `agent: <id>` (bare in YAML
  // examples). The id charset matches what bundled-agents actually use —
  // lowercase, dashes, digits.
  const AGENT_REF_RE = /\bagent:\s*["']?([a-z][a-z0-9-]*)["']?/g;

  // Window (in lines) within which a preceding `type: atlas` qualifies the
  // `agent:` reference as an atlas-baseAgentId reference (vs. a `type: user`
  // reference, which is freeform, or a `type: system` reference).
  // Empirically the gap between `type:` and `agent:` is 1 line in these
  // files; 5 gives slack for blank lines and inline comments.
  const ATLAS_QUALIFIER_WINDOW = 5;

  let primingFiles: string[] = [];

  beforeAll(async () => {
    const skillFiles = await walkSkills(SKILLS_ROOT);
    primingFiles = [...skillFiles, ...NON_SKILL_PRIMING_FILES].sort();
  });

  it("scans every system skill + workspace-chat priming file", () => {
    // Sanity: ensure the glob actually found the umbrella we expect, so a
    // structural rename of the skills tree fails loudly here rather than
    // silently scanning zero files.
    expect(primingFiles.length).toBeGreaterThanOrEqual(10);
    expect(primingFiles).toEqual(expect.arrayContaining(NON_SKILL_PRIMING_FILES));
  });

  it("every priming file references only real bundled-agent ids", async () => {
    const known = new Set(Object.keys(bundledAgentsRegistry));
    const offenders: { id: string; line: number; file: string }[] = [];

    const TYPE_RE = /\btype:\s*["']?(atlas|llm|user|system)["']?/g;

    for (const path of primingFiles) {
      const text = await readFile(path, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const match of line.matchAll(AGENT_REF_RE)) {
          const id = match[1];
          if (id === undefined) continue;
          // Only `type: atlas` references must resolve in the bundled
          // registry. Find the nearest preceding `type: <X>` (same line
          // first, then the search window). If X !== "atlas", skip.
          const sameLineType = [...line.matchAll(TYPE_RE)];
          let nearestType: string | undefined;
          if (sameLineType.length > 0) {
            // Take the last `type:` occurrence on the line — handles cheat-
            // sheet cells with both `type: user` AND `agent: "..."` inline.
            nearestType = sameLineType[sameLineType.length - 1]?.[1];
          } else {
            for (let j = i - 1; j >= Math.max(0, i - ATLAS_QUALIFIER_WINDOW); j--) {
              const m = [...(lines[j] ?? "").matchAll(TYPE_RE)];
              if (m.length > 0) {
                nearestType = m[m.length - 1]?.[1];
                break;
              }
            }
          }
          if (nearestType !== "atlas") continue;
          if (known.has(id)) continue;
          offenders.push({ id, line: i + 1, file: path });
        }
      }
    }

    if (offenders.length > 0) {
      const summary = offenders.map((o) => `  ${o.file}:${o.line} → agent: "${o.id}"`).join("\n");
      const knownList = [...known].sort().join(", ");
      throw new Error(
        `Found ${offenders.length} \`type: atlas\` reference(s) to bundled agents ` +
          `that don't exist in the registry:\n${summary}\n\n` +
          `Known bundled-agent ids: ${knownList}.\n` +
          `Either fix the reference or add the agent to packages/bundled-agents.`,
      );
    }
  });
});
