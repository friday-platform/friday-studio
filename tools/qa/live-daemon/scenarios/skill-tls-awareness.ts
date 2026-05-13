#!/usr/bin/env -S deno run --allow-all --env-file

/**
 * Skill TLS-awareness eval.
 *
 * After the HTTP/2 + TLS migration (commit 28cb596b7) the daemon
 * auto-upgrades its bind scheme to `https://` when FRIDAY_TLS_CERT is set.
 * Several skills under `packages/system/skills/` historically hardcoded
 * `http://localhost:8080` in their curl examples — an LLM that follows
 * those instructions verbatim hits the daemon's TLS listener with a
 * cleartext request and gets "Response does not match HTTP/1.1 protocol".
 *
 * This eval locks in two properties of the affected skills:
 *
 *  1. **Static** — no bare `http://localhost:8080` outside an explicit
 *     `${FRIDAYD_URL:-...}` fallback, a doc-comment, or a regex/literal
 *     fragment that is clearly *describing* the variable. Forces every
 *     copy-paste example into the env-aware shape.
 *
 *  2. **Behavioral** — feed the skill body to an LLM as a system prompt
 *     and ask it to write a one-line curl that pings `/health`. The
 *     response must reference `$FRIDAYD_URL` (or source `~/.atlas/.env`)
 *     and must NOT contain a bare `http://localhost:8080`. This proves
 *     the bytes we wrote into the skill actually steer the LLM.
 *
 * Run via promptfoo through `skill-tls-awareness-provider.cjs`, or
 * standalone:
 *
 *   deno run --allow-all tools/qa/live-daemon/scenarios/skill-tls-awareness.ts \
 *     --json-output /tmp/out.json
 */

import { walk } from "jsr:@std/fs@1.0.13";
import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, join, relative } from "jsr:@std/path@1";
import { currentGitSha, ensureCredentialsLoaded, HARNESS_PATHS } from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

function repoRoot(): string {
  // tools/qa/live-daemon/scenarios/skill-tls-awareness.ts → up 4 levels
  const here = new URL(".", import.meta.url).pathname;
  return join(here, "..", "..", "..", "..");
}

/**
 * Match a "bare daemon URL" — http://localhost:8080, http://127.0.0.1:8080,
 * any installer-port override like :18080, and https:// (since the
 * accompanying `--cacert` flag is what makes TLS *work*, not the scheme
 * alone). `getAtlasDaemonUrl()` actually returns `http://127.0.0.1:8080`
 * as its no-env default — the original detector pinned to `localhost`
 * missed that.
 */
const DAEMON_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\b/g;

/**
 * The canonical fallback expansion the skills teach. Variable-name-agnostic
 * — `${ANY_VAR:-http://…}` is the *teaching*, not the specific variable
 * name. Captures the four bash default-expansion forms (`:-`, `-`, `:=`,
 * `=`). Also tolerates whitespace inside `${ … }`.
 */
const BASH_FALLBACK_EXPANSION_RE =
  /\$\{\s*[A-Z_][A-Z0-9_]*\s*[:?=-]+\s*https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\s*\}/g;

/**
 * Find every daemon-URL occurrence in *executable* content (inside fenced
 * code blocks) that's NOT acceptable. URLs in prose, headings, frontmatter,
 * or markdown link text are ignored — the eval cares about copy-paste
 * commands, not narrative.
 *
 * Acceptable forms inside code blocks (filtered out before the violation
 * count):
 *   - `${ANY_VAR:-http://…}` and `-`/`:=`/`=` variants — bash default
 *     expansion.
 *   - `"FRIDAYD_URL", "http://…"` — Python `os.environ.get` default
 *     literal.
 *   - Comment lines (start with `#`) that describe what a variable
 *     resolves to (contain `→`).
 *
 * Everything else inside a code block — bare `curl http://…/...` — is a
 * violation.
 */
function staticViolations(text: string): { line: number; snippet: string }[] {
  const violations: { line: number; snippet: string }[] = [];
  const lines = text.split("\n");
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    // Track fenced-code-block state. Markdown fences are `` ``` `` (optionally
    // followed by a language). Blockquoted fences (`> \`\`\`bash`) also count
    // — the recipes.md preamble lives in a blockquote.
    if (/^\s*(?:>\s*)?```/.test(raw)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock) continue;

    // Strip every acceptable form first, then see if any daemon URL survives.
    let stripped = raw.replace(BASH_FALLBACK_EXPANSION_RE, "");
    // Python `.get("FRIDAYD_URL", "http://…")` — second-arg default literal.
    stripped = stripped.replace(
      /get\([^,)]+,\s*"https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?"\)/g,
      "",
    );
    if (!DAEMON_URL_RE.test(stripped)) {
      DAEMON_URL_RE.lastIndex = 0;
      continue;
    }
    DAEMON_URL_RE.lastIndex = 0;

    // Comment line describing what a variable resolves to (contains an arrow).
    const trimmed = raw.trim();
    if (trimmed.startsWith("#") && trimmed.includes("→")) continue;

    violations.push({ line: i + 1, snippet: raw.trim() });
  }
  return violations;
}

interface LlmJudgement {
  output: string;
  usesVariable: boolean;
  containsBareUrl: boolean;
  honorsCa: boolean;
  sourcesEnv: boolean;
}

const ENV_HINT_RE = /\.friday\/local|\.atlas\/\.env|FRIDAY_HOME|FRIDAYD_URL/i;
const VARIABLE_RE = /\$FRIDAYD_URL|\$\{\s*FRIDAYD_URL/;
// The skills teach two things — use $FRIDAYD_URL AND inject --cacert when
// TLS is on (either inline or via the `friday_curl` helper). Without this
// check the LLM can emit `curl "$FRIDAYD_URL/health"`, which on a TLS
// install fails with `self signed certificate in certificate chain`. The
// eval would have passed despite the user getting a non-working command.
const CA_HONOR_RE = /--cacert|FRIDAY_TLS_CA|\bfriday_curl\b/;

/**
 * "Bare URL" = a daemon-URL occurrence in the LLM output that is NOT
 * enclosed in the canonical fallback expansion. The expansion is fine —
 * it's the documented fallback shape. Anything else means the LLM
 * dropped the variable and emitted cleartext.
 */
function containsBareUrl(text: string): boolean {
  const stripped = text.replace(BASH_FALLBACK_EXPANSION_RE, "");
  return DAEMON_URL_RE.test(stripped);
}

async function callChild(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? [])
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && !!b.text)
    .map((b) => b.text)
    .join("");
}

async function llmJudgeSkill(body: string): Promise<LlmJudgement> {
  const output = await callChild(
    body,
    "Write a single shell command (no preamble, no explanation) that uses curl " +
      "to hit the Friday daemon's /health endpoint. Assume the user has already " +
      "sourced any environment they need. Output only the command.",
  );
  // DAEMON_URL_RE has the `g` flag; reset lastIndex before each test.
  DAEMON_URL_RE.lastIndex = 0;
  return {
    output,
    usesVariable: VARIABLE_RE.test(output),
    containsBareUrl: containsBareUrl(output),
    honorsCa: CA_HONOR_RE.test(output),
    sourcesEnv: ENV_HINT_RE.test(output),
  };
}

/**
 * Walk `packages/system/skills/**\/*.md` and return every markdown file
 * relative to the repo root. Auto-discovery so that a *new* skill with the
 * bad pattern fails this eval the day it lands — without anyone having to
 * remember to update a hardcoded allowlist.
 */
async function discoverSkillFiles(): Promise<string[]> {
  const root = repoRoot();
  const skillsRoot = join(root, "packages", "system", "skills");
  const out: string[] = [];
  for await (const entry of walk(skillsRoot, { exts: [".md"], includeDirs: false })) {
    out.push(relative(root, entry.path));
  }
  out.sort();
  return out;
}

async function runStaticChecks(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  const root = repoRoot();
  const paths = await discoverSkillFiles();

  // Single sweep: every skill file under packages/system/skills/**/*.md is
  // checked. The aggregate result fails if ANY file has a violation — the
  // primary defense against drift. Per-file results follow for granular
  // reporting in the promptfoo run.
  const aggregateViolations: { path: string; line: number; snippet: string }[] = [];

  for (const path of paths) {
    const full = join(root, path);
    let text: string;
    try {
      text = await Deno.readTextFile(full);
    } catch (err) {
      results.push({
        id: `skill-tls-static:${path}`,
        pass: false,
        notes: [`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`],
        metrics: { path },
      });
      continue;
    }
    const violations = staticViolations(text);
    for (const v of violations) aggregateViolations.push({ path, ...v });
    results.push({
      id: `skill-tls-static:${path}`,
      pass: violations.length === 0,
      notes:
        violations.length === 0
          ? ["no bare daemon URL outside acceptable fallback forms"]
          : violations.slice(0, 5).map((v) => `L${v.line}: ${v.snippet.slice(0, 140)}`),
      metrics: { path, violationCount: violations.length },
    });
  }

  // The sweep is the primary defense against drift: a new skill with a
  // bare URL must fail the eval the day it lands. That defense degrades
  // silently if `discoverSkillFiles()` returns [] — skills dir relocated,
  // glob pattern broken, package boundary change. `paths.length > 0` is
  // the discrimination signal that distinguishes "30 files all clean"
  // from "no files scanned and we have no idea." See review v2 Important
  // #2.
  const swept = paths.length > 0;
  const clean = aggregateViolations.length === 0;
  results.push({
    id: "skill-tls-static:sweep",
    pass: swept && clean,
    notes: !swept
      ? [
          "FAIL: discoverSkillFiles() returned 0 files — skills directory moved, " +
            "glob pattern broken, or the skills/ tree was relocated. The auto-" +
            "discovery sweep cannot protect against drift if it finds nothing.",
        ]
      : clean
        ? [`swept ${paths.length} skill markdown file(s) — all clean`]
        : aggregateViolations
            .slice(0, 8)
            .map((v) => `${v.path}:${v.line}: ${v.snippet.slice(0, 100)}`),
    metrics: { filesScanned: paths.length, totalViolations: aggregateViolations.length },
  });

  return results;
}

/**
 * Negative-control fixtures for `staticViolations`. These are synthetic
 * markdown snippets that would be incorrect to ship in a real skill — the
 * eval here passes when the detector *flags* them (i.e. violationCount > 0).
 * Without these, a bug that makes `staticViolations` always return [] would
 * silently turn every positive check into vacuous pass. Negative controls
 * are the only way to prove the detector still has signal.
 */
const STATIC_NEGATIVE_FIXTURES: { id: string; body: string; expectMin: number }[] = [
  {
    id: "bare-curl-in-code-fence",
    body: ["# Bad skill", "", "```bash", "curl -s http://localhost:8080/health", "```", ""].join(
      "\n",
    ),
    expectMin: 1,
  },
  {
    id: "post-with-bare-url",
    body: [
      "Trigger a signal:",
      "",
      "```bash",
      "curl -X POST http://localhost:8080/api/workspaces/foo/signals/bar -d '{}'",
      "```",
    ].join("\n"),
    expectMin: 1,
  },
  {
    id: "quoted-bare-url-in-code",
    body:
      "```bash\n" +
      'curl -s "http://localhost:8080/api/sessions/$SID"  # inspect session\n' +
      "```\n",
    expectMin: 1,
  },
  // Detector must catch 127.0.0.1 too — that's getAtlasDaemonUrl()'s actual
  // no-env default (utils.ts:71). Pinning to "localhost" missed this.
  {
    id: "loopback-127-url",
    body: "```bash\ncurl -s http://127.0.0.1:8080/api/workspaces\n```\n",
    expectMin: 1,
  },
  // Installer commonly writes :18080 to dodge port collisions.
  {
    id: "port-override-url",
    body: "```bash\ncurl -s http://localhost:18080/health\n```\n",
    expectMin: 1,
  },
];

/**
 * Negative-control fixtures for the static-check ACCEPTANCE rules. These
 * patterns SHOULD pass the detector (violationCount must stay 0): the
 * bash default expansion, the python os.environ.get default, the
 * descriptive arrow line, and the "defaults to `…`" prose. Locks in the
 * detector's whitelist — a regression that over-tightens it would flag
 * these and fail the eval.
 */
const STATIC_ACCEPT_FIXTURES: { id: string; body: string }[] = [
  {
    id: "bash-default-expansion",
    body: '```bash\ncurl -sf "${FRIDAYD_URL:-http://localhost:8080}/health"\n```\n',
  },
  // Variant bash-default forms (single-dash, := assignment, with whitespace)
  // — all semantically equivalent. The detector should accept all of them.
  {
    id: "bash-default-single-dash",
    body: '```bash\ncurl -sf "${FRIDAYD_URL-http://localhost:8080}/health"\n```\n',
  },
  {
    id: "bash-default-assignment",
    body: '```bash\ncurl -sf "${FRIDAYD_URL:=http://localhost:8080}/health"\n```\n',
  },
  // Variable-name-agnostic: the skill mentions a playground URL via a
  // non-FRIDAYD variable. Should still be accepted — bash default is the
  // teaching, not the specific variable name.
  {
    id: "bash-default-other-var",
    body: '```bash\ncurl -sf "${PLAYGROUND_URL:-http://localhost:5200}/api/x"\n```\n',
  },
  {
    id: "python-environ-default",
    body: '```python\ndaemon_url = os.environ.get("FRIDAYD_URL", "http://localhost:8080")\n```\n',
  },
  {
    id: "arrow-doc-comment-in-code",
    body: "```bash\n# $FRIDAYD_URL → http://localhost:8080 (plain) or https://... (TLS)\n```\n",
  },
  // URLs in plain prose (outside code fences) must never trip the detector —
  // they're describing behavior, not asking to be copy-pasted.
  { id: "prose-mention", body: "The daemon listens on `http://localhost:8080` by default.\n" },
  {
    id: "frontmatter-description",
    body: '---\ndescription: "API on localhost:8080 (or https://localhost:8080 when TLS)"\n---\n',
  },
];

function runStaticNegativeControls(): EvalResult[] {
  const results: EvalResult[] = [];
  for (const { id, body, expectMin } of STATIC_NEGATIVE_FIXTURES) {
    const violations = staticViolations(body);
    const first = violations[0];
    results.push({
      id: `skill-tls-static-negative:${id}`,
      pass: violations.length >= expectMin,
      notes: [
        `expected ≥${expectMin} violation(s) in synthetic bad fixture`,
        `detected: ${violations.length}`,
        first ? `first: ${first.snippet.slice(0, 120)}` : "(none detected)",
      ],
      metrics: { violationCount: violations.length, expectMin },
    });
  }
  for (const { id, body } of STATIC_ACCEPT_FIXTURES) {
    const violations = staticViolations(body);
    const first = violations[0];
    results.push({
      id: `skill-tls-static-accept:${id}`,
      pass: violations.length === 0,
      notes: [
        "acceptable fallback form — detector must not flag it",
        `detected: ${violations.length}`,
        first ? `false-positive: ${first.snippet.slice(0, 120)}` : "(clean)",
      ],
      metrics: { violationCount: violations.length },
    });
  }
  return results;
}

async function runBehavioralChecks(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  // Only the top-level SKILL.md files have a body short enough + advisory
  // enough to use as a system prompt without confusing the model. The
  // references are read on-demand via load_skill in production; teaching
  // them as a primary system prompt would tank LLM coherence.
  const subjects = [
    { id: "friday-cli/SKILL.md", path: "packages/system/skills/friday-cli/SKILL.md" },
    { id: "workspace-api/SKILL.md", path: "packages/system/skills/workspace-api/SKILL.md" },
    {
      id: "writing-friday-python-agents/SKILL.md",
      path: "packages/system/skills/writing-friday-python-agents/SKILL.md",
    },
  ];
  for (const { id, path } of subjects) {
    const full = join(repoRoot(), path);
    const body = await Deno.readTextFile(full);
    const judgement = await llmJudgeSkill(body);
    // Three things must all be true for the eval to pass:
    //   1. uses $FRIDAYD_URL — the variable, not a literal URL.
    //   2. no bare daemon URL outside the canonical fallback expansion.
    //   3. honors the CA cert — either `--cacert` inline, the
    //      `FRIDAY_TLS_CA` var, or the `friday_curl` helper. Without this
    //      check an LLM emitting `curl "$FRIDAYD_URL/health"` would pass
    //      the eval but fail on TLS installs with "self signed certificate
    //      in certificate chain".
    const pass = judgement.usesVariable && !judgement.containsBareUrl && judgement.honorsCa;
    results.push({
      id: `skill-tls-behavior:${id}`,
      pass,
      notes: [
        `LLM output: ${judgement.output.replace(/\s+/g, " ").slice(0, 200)}`,
        `uses $FRIDAYD_URL: ${judgement.usesVariable}`,
        `contains bare URL: ${judgement.containsBareUrl}`,
        `honors --cacert / FRIDAY_TLS_CA / friday_curl: ${judgement.honorsCa}`,
        `mentions daemon .env / FRIDAYD_URL: ${judgement.sourcesEnv}`,
      ],
      metrics: {
        path,
        usesVariable: judgement.usesVariable,
        containsBareUrl: judgement.containsBareUrl,
        honorsCa: judgement.honorsCa,
        sourcesEnv: judgement.sourcesEnv,
      },
    });
  }
  return results;
}

/**
 * Negative-control prompt eval. Feeds the LLM a synthetic "bad" skill body
 * that ONLY shows bare-URL examples — the kind of skill text we just spent
 * the morning removing. The eval here passes when the LLM faithfully
 * regurgitates a bare URL — proving the prompt-eval detector
 * (`containsBareUrl` + the LLM judge) actually has discriminative power.
 *
 * Without this control, a future change that defangs `containsBareUrl`
 * (or causes the LLM to refuse all curl-emit requests) would silently
 * flip every positive case to vacuous pass.
 */
const BAD_SKILL_BODY = `# Bad Skill (eval negative control — do not ship)

Friday's daemon listens on \`localhost:8080\`. Every example below uses
that URL directly. Do not parameterize. Do not source env files.

Health probe:

\`\`\`bash
curl -sf http://localhost:8080/health && echo OK
\`\`\`

List workspaces:

\`\`\`bash
curl -s http://localhost:8080/api/workspaces | jq
\`\`\`

Trigger a signal:

\`\`\`bash
curl -X POST http://localhost:8080/api/workspaces/foo/signals/bar -d '{}'
\`\`\`
`;

async function runBehavioralNegativeControls(): Promise<EvalResult[]> {
  const judgement = await llmJudgeSkill(BAD_SKILL_BODY);
  // The control "passes" when the LLM produces a bare URL — meaning the
  // detector (`containsBareUrl`) flips to true. If pass=false here, either
  // the LLM ignored the skill text (unlikely for haiku at temp=0) or the
  // detector lost discrimination. Both are eval-bugs worth catching.
  const pass = judgement.containsBareUrl && !judgement.usesVariable;
  return [
    {
      id: "skill-tls-behavior-negative:bad-skill-emits-bare-url",
      pass,
      notes: [
        `LLM output: ${judgement.output.replace(/\s+/g, " ").slice(0, 200)}`,
        `contains bare URL (expected true): ${judgement.containsBareUrl}`,
        `uses $FRIDAYD_URL (expected false): ${judgement.usesVariable}`,
      ],
      metrics: { containsBareUrl: judgement.containsBareUrl, usesVariable: judgement.usesVariable },
    },
  ];
}

async function main() {
  await ensureCredentialsLoaded();

  const args = Deno.args;
  const jsonOutputIdx = args.indexOf("--json-output");
  const jsonOutputPath = jsonOutputIdx >= 0 ? args[jsonOutputIdx + 1] : undefined;
  const writeResult = args.includes("--write");
  const skipBehavioral = args.includes("--static-only") || !Deno.env.get("ANTHROPIC_API_KEY");

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  console.log(`▶ skill-tls-awareness eval @ ${sha}`);

  const results: EvalResult[] = [];
  console.log("\n── static checks ──");
  results.push(...(await runStaticChecks()));
  console.log("\n── static negative controls (detector discrimination) ──");
  results.push(...runStaticNegativeControls());

  if (skipBehavioral) {
    console.log("\n(skip) behavioral checks — ANTHROPIC_API_KEY not set or --static-only");
  } else {
    console.log("\n── behavioral checks (LLM judgement) ──");
    results.push(...(await runBehavioralChecks()));
    console.log("\n── behavioral negative control (bad skill must produce bare URL) ──");
    results.push(...(await runBehavioralNegativeControls()));
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ skill-tls-awareness summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const path =
      jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-skill-tls-awareness.json`);
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
    console.log(`\n→ ${path}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
