#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

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

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, join } from "jsr:@std/path@1";
import { currentGitSha, ensureCredentialsLoaded, HARNESS_PATHS } from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

// Skills we expect to teach the LLM the TLS-aware shape. Path is relative
// to the monorepo root (resolved below via `repoRoot()`).
const SKILL_FILES: { id: string; path: string }[] = [
  { id: "friday-cli/SKILL.md", path: "packages/system/skills/friday-cli/SKILL.md" },
  {
    id: "friday-cli/references/http.md",
    path: "packages/system/skills/friday-cli/references/http.md",
  },
  {
    id: "friday-cli/references/recipes.md",
    path: "packages/system/skills/friday-cli/references/recipes.md",
  },
  {
    id: "friday-cli/references/session-and-logs.md",
    path: "packages/system/skills/friday-cli/references/session-and-logs.md",
  },
  {
    id: "friday-cli/references/cli.md",
    path: "packages/system/skills/friday-cli/references/cli.md",
  },
  { id: "workspace-api/SKILL.md", path: "packages/system/skills/workspace-api/SKILL.md" },
  {
    id: "workspace-api/references/updating-workspaces.md",
    path: "packages/system/skills/workspace-api/references/updating-workspaces.md",
  },
  {
    id: "writing-friday-python-agents/SKILL.md",
    path: "packages/system/skills/writing-friday-python-agents/SKILL.md",
  },
];

function repoRoot(): string {
  // tools/qa/live-daemon/scenarios/skill-tls-awareness.ts → up 4 levels
  const here = new URL(".", import.meta.url).pathname;
  return join(here, "..", "..", "..", "..");
}

/**
 * Find every `http://localhost:8080` occurrence that's NOT acceptable.
 *
 * Acceptable forms (will be filtered out before the violation count):
 *   - `${FRIDAYD_URL:-http://localhost:8080}` — bash default expansion.
 *   - `"FRIDAYD_URL", "http://localhost:8080"` — Python `os.environ.get`
 *     default literal (positional second argument).
 *   - Inside an HTML comment / blockquote line that just describes what
 *     `$FRIDAYD_URL` resolves to: a line containing `→` and the URL.
 *   - In a "defaults to ..." prose sentence inside backticks: the http
 *     ref appears in `` `http://localhost:8080` `` style.
 *
 * Everything else — bare `curl http://localhost:8080/...` in a code block,
 * fences without the fallback shape — is a violation.
 */
function staticViolations(text: string): { line: number; snippet: string }[] {
  const violations: { line: number; snippet: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("http://localhost:8080")) continue;

    // Acceptable: bash default expansion `${FRIDAYD_URL:-http://localhost:8080}`.
    if (line.includes("${FRIDAYD_URL:-http://localhost:8080}")) continue;

    // Acceptable: Python `.get("FRIDAYD_URL", "http://localhost:8080")`.
    if (/get\("FRIDAYD_URL",\s*"http:\/\/localhost:8080"\)/.test(line)) continue;

    // Acceptable: a comment/blockquote line that's *describing* what the
    // variable resolves to (contains an arrow glyph and the URL).
    if (line.includes("→") && line.includes("http://localhost:8080")) continue;

    // Acceptable: prose where the URL appears inside backticks and the
    // line also mentions "default" or "fallback" (lets us say "defaults to
    // `http://localhost:8080`" without flagging it).
    if (/`http:\/\/localhost:8080`/.test(line) && /default|fallback/i.test(line)) continue;

    violations.push({ line: i + 1, snippet: line.trim() });
  }
  return violations;
}

interface LlmJudgement {
  output: string;
  usesVariable: boolean;
  containsBareUrl: boolean;
  sourcesEnv: boolean;
}

const ENV_HINT_RE = /\.atlas\/\.env|FRIDAYD_URL/i;
const VARIABLE_RE = /\$FRIDAYD_URL|\$\{FRIDAYD_URL/;

/**
 * "Bare URL" = a `http://localhost:8080` occurrence in the LLM output that
 * is NOT enclosed in the recommended bash default expansion
 * `${FRIDAYD_URL:-http://localhost:8080}`. The expansion is fine — it's
 * the documented fallback shape. Anything else means the LLM dropped the
 * variable and emitted cleartext.
 */
function containsBareUrl(text: string): boolean {
  const stripped = text.replaceAll("${FRIDAYD_URL:-http://localhost:8080}", "");
  return /http:\/\/localhost:8080/.test(stripped);
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
  return {
    output,
    usesVariable: VARIABLE_RE.test(output),
    containsBareUrl: containsBareUrl(output),
    sourcesEnv: ENV_HINT_RE.test(output),
  };
}

async function runStaticChecks(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const { id, path } of SKILL_FILES) {
    const full = join(repoRoot(), path);
    let text: string;
    try {
      text = await Deno.readTextFile(full);
    } catch (err) {
      results.push({
        id: `skill-tls-static:${id}`,
        pass: false,
        notes: [`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`],
        metrics: { path },
      });
      continue;
    }
    const violations = staticViolations(text);
    results.push({
      id: `skill-tls-static:${id}`,
      pass: violations.length === 0,
      notes:
        violations.length === 0
          ? ["no bare http://localhost:8080 outside acceptable fallback forms"]
          : violations.slice(0, 5).map((v) => `L${v.line}: ${v.snippet.slice(0, 140)}`),
      metrics: { path, violationCount: violations.length },
    });
  }
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
    id: "quoted-bare-url",
    body: 'Use `curl -s "http://localhost:8080/api/sessions/$SID"` to inspect.\n',
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
    body: 'curl -sf "${FRIDAYD_URL:-http://localhost:8080}/health"\n',
  },
  {
    id: "python-environ-default",
    body: 'daemon_url = os.environ.get("FRIDAYD_URL", "http://localhost:8080")\n',
  },
  {
    id: "arrow-doc-comment",
    body: "# $FRIDAYD_URL → http://localhost:8080 (plain) or https://... (TLS)\n",
  },
  {
    id: "prose-default-in-backticks",
    body: "The daemon defaults to `http://localhost:8080` on a plain-HTTP install.\n",
  },
];

function runStaticNegativeControls(): EvalResult[] {
  const results: EvalResult[] = [];
  for (const { id, body, expectMin } of STATIC_NEGATIVE_FIXTURES) {
    const violations = staticViolations(body);
    results.push({
      id: `skill-tls-static-negative:${id}`,
      pass: violations.length >= expectMin,
      notes: [
        `expected ≥${expectMin} violation(s) in synthetic bad fixture`,
        `detected: ${violations.length}`,
        violations.length > 0 ? `first: ${violations[0].snippet.slice(0, 120)}` : "(none detected)",
      ],
      metrics: { violationCount: violations.length, expectMin },
    });
  }
  for (const { id, body } of STATIC_ACCEPT_FIXTURES) {
    const violations = staticViolations(body);
    results.push({
      id: `skill-tls-static-accept:${id}`,
      pass: violations.length === 0,
      notes: [
        "acceptable fallback form — detector must not flag it",
        `detected: ${violations.length}`,
        violations.length > 0
          ? `false-positive: ${violations[0].snippet.slice(0, 120)}`
          : "(clean)",
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
    const pass = judgement.usesVariable && !judgement.containsBareUrl;
    results.push({
      id: `skill-tls-behavior:${id}`,
      pass,
      notes: [
        `LLM output: ${judgement.output.replace(/\s+/g, " ").slice(0, 200)}`,
        `uses $FRIDAYD_URL: ${judgement.usesVariable}`,
        `contains bare URL: ${judgement.containsBareUrl}`,
        `mentions .env / FRIDAYD_URL: ${judgement.sourcesEnv}`,
      ],
      metrics: {
        path,
        usesVariable: judgement.usesVariable,
        containsBareUrl: judgement.containsBareUrl,
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
