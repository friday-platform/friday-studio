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

import { dirname, join, relative } from "jsr:@std/path@1";
import { currentGitSha, ensureCredentialsLoaded, HARNESS_PATHS } from "../harness.ts";

/**
 * Recursively yield every `.md` file under `root`. Replacement for
 * `@std/fs walk()` — avoids dragging in @std/fs just for one helper, and
 * keeps the lock leaner (the @std/fs version sibling scenarios pin
 * transitively constrained @std/path@^1.0.8 even though everything
 * resolves to 1.1.4).
 */
async function* walkMd(root: string): AsyncIterableIterator<string> {
  for await (const entry of Deno.readDir(root)) {
    const full = join(root, entry.name);
    if (entry.isDirectory) {
      yield* walkMd(full);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

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

/** The synthetic FRIDAYD_URL we tell the LLM it "looked up" via run_code.
 *  Picked to be distinct from any port a bad-skill body might hardcode,
 *  so we can tell the difference between "LLM substituted the lookup
 *  value" and "LLM regurgitated the skill's literal port". */
const INJECTED_FRIDAYD_URL = "https://localhost:18080";

interface LlmJudgement {
  output: string;
  /** LLM emitted `$FRIDAYD_URL` literal — BAD. The user's shell has no
   *  such variable; the LLM should have resolved it via run_code first. */
  emitsVariableLiteral: boolean;
  containsBareUrl: boolean;
  /** Output contains a resolved daemon URL (http(s)://localhost:N or
   *  127.0.0.1:N) — what the user can actually paste and run. */
  emitsResolvedUrl: boolean;
  /** Output contains the SPECIFIC URL we injected as the run_code result.
   *  Stricter than emitsResolvedUrl — distinguishes "LLM substituted from
   *  the lookup" from "LLM hardcoded a different port". */
  emitsInjectedUrl: boolean;
  skipsCertVerify: boolean;
}

const VARIABLE_LITERAL_RE = /\$FRIDAYD_URL|\$\{\s*FRIDAYD_URL/;
// Skills teach two rules — (1) resolve $FRIDAYD_URL first then emit the
// literal value, and (2) skip cert verification via `-k` / `--insecure`
// so it works on both plain-HTTP (no-op) and TLS (skip private-CA leaf)
// installs. `-k` is safe because the daemon binds loopback only.
const SKIP_VERIFY_RE = /\s-(?:[A-Za-z]*k|-insecure\b)/;

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

async function llmJudgeSkillWithPrompt(
  body: string,
  ask: string,
  options: { inject?: boolean } = { inject: true },
): Promise<LlmJudgement> {
  // For positive tests: inject the resolved-FRIDAYD_URL context the
  // skill teaches the LLM to produce via run_code. The test focuses on
  // *substitution* behavior, not on whether the LLM remembers to call
  // run_code.
  //
  // For negative tests: feed ONLY the bad-skill body. Injection would
  // override the bad teaching by making the LLM substitute the injected
  // value regardless of skill content — the bad skill never gets to
  // demonstrate its failure mode.
  const userPrompt = options.inject
    ? `Context: you ran \`python -c "import os; print(os.environ['FRIDAYD_URL'])"\` ` +
      `and got the literal string "${INJECTED_FRIDAYD_URL}". ` +
      `${ask} ` +
      "Output only the command — no preamble, no explanation, no markdown."
    : `${ask} Output only the command — no preamble, no explanation, no markdown.`;
  const output = await callChild(body, userPrompt);
  // DAEMON_URL_RE has the `g` flag; reset lastIndex before each test.
  DAEMON_URL_RE.lastIndex = 0;
  const emitsResolvedUrl = DAEMON_URL_RE.test(output);
  DAEMON_URL_RE.lastIndex = 0;
  return {
    output,
    emitsVariableLiteral: VARIABLE_LITERAL_RE.test(output),
    containsBareUrl: containsBareUrl(output),
    emitsResolvedUrl,
    emitsInjectedUrl: output.includes(INJECTED_FRIDAYD_URL),
    skipsCertVerify: SKIP_VERIFY_RE.test(output),
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
  for await (const path of walkMd(skillsRoot)) {
    out.push(relative(root, path));
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
  // Installed Friday Studio: TLS-bound daemon on :18080 with private-CA
  // s2s cert. A bare `https://localhost:18080` curl without --cacert
  // fails on installed Studio with "self signed certificate in
  // certificate chain". Detector must flag the hardcoded HTTPS URL.
  {
    id: "installed-studio-https-bare-url",
    body: "```bash\ncurl -s https://localhost:18080/api/workspaces | jq\n```\n",
    expectMin: 1,
  },
  // Installer-port + 127.0.0.1 combo — same misroute risk on installed
  // Studio if the LLM happens to encode the loopback IP.
  {
    id: "installed-studio-loopback-url",
    body: "```bash\ncurl -s http://127.0.0.1:18080/api/sessions\n```\n",
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
  // Installed Friday Studio context — prose explaining the :18080 binding
  // is legitimate documentation, not a hardcoded curl. Must not trip.
  {
    id: "prose-installed-studio-port",
    body: "Installed Friday Studio binds the daemon on `https://localhost:18080`. Dev runs `:8080`.\n",
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
  // Every changed skill markdown file gets a behavioral LLM check. References
  // aren't loaded as system prompts in production (they come in via
  // `load_skill`), but feeding each body as a system prompt and asking for
  // a relevant curl is the most direct way to verify the bytes we wrote
  // actually steer the LLM toward $FRIDAYD_URL + --cacert. If a reference
  // body fails, that's a signal the curl examples inside it don't put the
  // teaching pattern close enough to where the LLM is reading.
  const subjects = [
    {
      id: "friday-cli/SKILL.md",
      path: "packages/system/skills/friday-cli/SKILL.md",
      ask: "Write a single shell command to hit the daemon's /health endpoint.",
    },
    {
      id: "friday-cli/references/cli.md",
      path: "packages/system/skills/friday-cli/references/cli.md",
      // Note: do NOT say "using curl" — that primes Haiku toward plain
      // curl over the friday_curl wrapper the skill actually teaches.
      // Let the skill body steer.
      ask: "Write a single shell command to register a Python agent at /abs/agent.py.",
    },
    {
      id: "friday-cli/references/http.md",
      path: "packages/system/skills/friday-cli/references/http.md",
      ask: "Write a single shell command to GET the /health endpoint.",
    },
    {
      id: "friday-cli/references/recipes.md",
      path: "packages/system/skills/friday-cli/references/recipes.md",
      ask: "Write a single shell command to list workspaces from the daemon.",
    },
    {
      id: "friday-cli/references/session-and-logs.md",
      path: "packages/system/skills/friday-cli/references/session-and-logs.md",
      ask: "Write a single shell command to fetch session $SID details from the daemon.",
    },
    {
      id: "workspace-api/SKILL.md",
      path: "packages/system/skills/workspace-api/SKILL.md",
      ask: "Write a single shell command to list workspaces from the daemon.",
    },
    {
      id: "workspace-api/references/updating-workspaces.md",
      path: "packages/system/skills/workspace-api/references/updating-workspaces.md",
      ask: "Write a single shell command to GET /api/workspaces/$WS/config from the daemon.",
    },
    {
      id: "writing-friday-python-agents/SKILL.md",
      path: "packages/system/skills/writing-friday-python-agents/SKILL.md",
      ask: "Write a single shell command to register a Python agent at /abs/agent.py.",
    },
    // Installed-Studio priming: the user mentions :18080 explicitly. The
    // LLM must NOT hardcode the port in its output — the rule is "always
    // use $FRIDAYD_URL". This catches a subtle failure mode where the LLM
    // sees the user-supplied port and bypasses the skill's teaching.
    {
      id: "friday-cli/SKILL.md#installed-studio-priming",
      path: "packages/system/skills/friday-cli/SKILL.md",
      ask:
        "I'm running installed Friday Studio (the daemon is on port 18080). " +
        "Give me a shell command to hit the /health endpoint.",
    },
    {
      id: "workspace-api/SKILL.md#installed-studio-priming",
      path: "packages/system/skills/workspace-api/SKILL.md",
      ask:
        "I'm running installed Friday Studio with TLS on (the daemon is on " +
        "https://localhost:18080). Write a shell command to list workspaces.",
    },
  ];
  for (const { id, path, ask } of subjects) {
    const full = join(repoRoot(), path);
    const body = await Deno.readTextFile(full);
    const judgement = await llmJudgeSkillWithPrompt(body, ask);
    // Three things must all be true for the eval to pass:
    //   1. emits the SPECIFIC injected URL (https://localhost:18080) —
    //      not the `$FRIDAYD_URL` variable, not a different hardcoded
    //      port. The user's shell has no `$FRIDAYD_URL`, and only the
    //      injected value matches their actual daemon.
    //   2. does NOT contain the `$FRIDAYD_URL` literal in output.
    //   3. skips cert verification via `-k` / `--insecure`. Without this
    //      the example fails on TLS installs with "self signed
    //      certificate in certificate chain". `-k` is safe because the
    //      daemon binds loopback only.
    const pass =
      judgement.emitsInjectedUrl && !judgement.emitsVariableLiteral && judgement.skipsCertVerify;
    results.push({
      id: `skill-tls-behavior:${id}`,
      pass,
      notes: [
        `LLM output: ${judgement.output.replace(/\s+/g, " ").slice(0, 200)}`,
        `emits injected URL (${INJECTED_FRIDAYD_URL}): ${judgement.emitsInjectedUrl}`,
        `emits $FRIDAYD_URL literal (bad): ${judgement.emitsVariableLiteral}`,
        `skips cert verify (-k / --insecure): ${judgement.skipsCertVerify}`,
      ],
      metrics: {
        path,
        emitsInjectedUrl: judgement.emitsInjectedUrl,
        emitsVariableLiteral: judgement.emitsVariableLiteral,
        skipsCertVerify: judgement.skipsCertVerify,
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
/**
 * Negative-control prompt evals. Each body is a synthetic "bad" skill that
 * ONLY shows bare-URL examples in a different framing. The eval here passes
 * when the LLM faithfully regurgitates a bare URL — proving the LLM judge
 * actually has discriminative power.
 *
 * Multiple bodies cover different stylistic framings (bash-heavy, Python-
 * agent-style, prose-heavy) so a model-drift event that breaks one framing
 * is unlikely to break all three simultaneously. If ALL THREE pass=false
 * at the same time, the LLM-judge has genuinely lost signal — investigate
 * before retrying.
 */
const BAD_SKILL_BODIES: { id: string; ask: string; body: string }[] = [
  // Under the new model the LLM is told via injected context what
  // FRIDAYD_URL resolves to. So a bad-skill body has to teach a
  // DIFFERENT failure mode — not "use this hardcoded port" (the LLM
  // ignores it in favor of the injected lookup result), but rather
  // "skip the lookup and emit the $FRIDAYD_URL literal" or "skip the
  // -k flag".
  {
    id: "emit-variable-literal",
    ask: "Write a single shell command to hit the daemon's /health endpoint.",
    body: `# Bad Skill (eval negative control — do not ship)

The daemon URL is in \`$FRIDAYD_URL\`. Don't resolve it. Don't look it up.
Just put \`$FRIDAYD_URL\` directly in the curl command — the user's shell
will sort it out.

\`\`\`bash
curl -k "$FRIDAYD_URL/health"
\`\`\`

This is the canonical pattern. The whole point of having a variable is to
reference it by name.
`,
  },
  {
    id: "omit-cert-skip",
    ask: "Write a single shell command to list workspaces.",
    body: `# Bad Skill (eval negative control — do not ship)

The daemon is on the local network so cert verification works fine. Use
plain \`curl\` — never \`-k\` or \`--insecure\`, those are dangerous flags
that should never appear in production code. Always verify certs.

\`\`\`bash
curl -s "$FRIDAYD_URL/api/workspaces" | jq
\`\`\`
`,
  },
  {
    id: "bash-heavy-bare-url",
    ask: "Write a single shell command to list workspaces from the daemon.",
    body: `# Bad Workspace Skill (eval negative control — do not ship)

The Friday daemon exposes its HTTP API at \`http://localhost:8080\`. This
is the canonical local endpoint; in dev there is nothing else.

To list workspaces:

\`\`\`bash
curl -s http://localhost:8080/api/workspaces | jq
\`\`\`

To get one:

\`\`\`bash
curl -s http://localhost:8080/api/workspaces/$WS_ID | jq
\`\`\`
`,
  },
];

async function runBehavioralNegativeControls(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const { id, ask, body } of BAD_SKILL_BODIES) {
    // Feed the bad skill body WITHOUT the resolved-URL injection — the
    // injection would override the skill's teaching and defeat the
    // test. Each bad body teaches one of the three failure modes the
    // positive eval guards against; the LLM should follow the bad
    // teaching and produce broken output.
    const judgement = await llmJudgeSkillWithPrompt(body, ask, { inject: false });
    // The control "passes" when the LLM's output violates AT LEAST ONE
    // of the three positive rules: emits the variable literal, or fails
    // to skip cert verify, or contains a bare URL (in which case the
    // injected-URL check is moot — we're not injecting).
    const violatesRule =
      judgement.emitsVariableLiteral || !judgement.skipsCertVerify || judgement.containsBareUrl;
    results.push({
      id: `skill-tls-behavior-negative:${id}`,
      pass: violatesRule,
      notes: [
        `LLM output: ${judgement.output.replace(/\s+/g, " ").slice(0, 200)}`,
        `emits $FRIDAYD_URL literal: ${judgement.emitsVariableLiteral}`,
        `skips cert verify: ${judgement.skipsCertVerify}`,
        `contains bare URL: ${judgement.containsBareUrl}`,
        `(negative pass = ANY positive rule violated)`,
      ],
      metrics: {
        emitsVariableLiteral: judgement.emitsVariableLiteral,
        skipsCertVerify: judgement.skipsCertVerify,
        containsBareUrl: judgement.containsBareUrl,
      },
    });
  }
  return results;
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
    // Deno.mkdir({ recursive: true }) is a no-op if the dir exists, same
    // behavior as @std/fs ensureDir without the import.
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
    console.log(`\n→ ${path}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
