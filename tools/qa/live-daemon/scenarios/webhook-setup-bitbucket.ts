#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Webhook-setup (Bitbucket) eval — chat-driven setup-guidance contract.
 *
 * When a user with a `provider: http` signal in their workspace asks
 * workspace-chat "how do I configure Bitbucket to call this signal?",
 * the response must answer with the canonical wiring details (URL
 * pattern, env var, signature header, event allowlist, /status
 * debugging) and explicitly avoid the foot-guns Marc hit in the
 * 2026-05-15 chat dump (BITBUCKET_WEBHOOK_SECRET, malformed
 * webhook-mappings.json, `/hook/raw/` bypass advice).
 *
 * Two variants prove the `wiring-external-webhooks` skill is what
 * drives the right answer:
 *
 *   - WITH-SKILL (positive): the skill content is appended to the
 *     system prompt as if `load_skill` had been called and surfaced.
 *     Must pass all 8 contract checks.
 *   - WITHOUT-SKILL (negative / control): just the bare workspace-chat
 *     prompt.txt. Must FAIL at least one of the "knows the URL pattern
 *     and env var" checks — proves the model doesn't already have this
 *     domain knowledge from training and that the skill is the carrier.
 *
 * Same direct-Anthropic-call shape as `secret-input-guard.ts` and
 * `connect-service-on-auth-error.ts` — no daemon spawn, no workspace
 * registration, ~15s per run.
 *
 * Run:
 *   ./tools/qa/live-daemon/scenarios/webhook-setup-bitbucket.ts
 *   ./tools/qa/live-daemon/scenarios/webhook-setup-bitbucket.ts --only with-skill
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { currentGitSha, HARNESS_PATHS } from "../harness.ts";

interface ContractCheck {
  id: string;
  description: string;
  pass: boolean;
  evidence?: string;
}

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..", "..", "..");
const PROMPT_PATH = join(ROOT, "packages/system/agents/workspace-chat/prompt.txt");
const SKILL_PATH = join(ROOT, "packages/system/skills/wiring-external-webhooks/SKILL.md");

// Synthetic workspace context inlined into the system prompt — mirrors the
// shape `formatWorkspaceSection` produces at runtime (workspace-chat.agent.ts).
// The user has a `provider: http` signal called `bitbucket-pipeline-failed`
// at path `/bitbucket-pipeline-failed`. The chat must give Bitbucket-side
// wiring instructions for this signal.
const WORKSPACE_SECTION = `<workspace>
<workspace_id>light_papaya</workspace_id>
<workspace_name>Bitbucket Pipeline Test</workspace_name>
<signals>
<signal id="bitbucket-pipeline-failed" provider="http" path="/bitbucket-pipeline-failed">Bitbucket webhook — pipeline build status updates.</signal>
</signals>
<jobs>
<job name="handle-pipeline-failed" triggers="bitbucket-pipeline-failed">Receives the Bitbucket webhook payload.</job>
</jobs>
</workspace>`;

const SKILL_INDEX_WITH_WIRING = `<available_skills>
<instruction>Index of skills visible to this workspace. Each entry is ref + one-line summary. Use describe_skill for full descriptions, load_skill to bring instructions into chat, search_skills/list_skills to discover.</instruction>
<skill name="@friday/wiring-external-webhooks">Wires Bitbucket / Jira / custom webhooks to a workspace's HTTP signal via /hook/raw/.</skill>
</available_skills>`;

const USER_QUESTION_SETUP =
  "I added a `bitbucket-pipeline-failed` HTTP signal to this workspace. How do I configure Bitbucket Cloud to send pipeline-failure events to it? Walk me through the URL to paste in Bitbucket, what secret to set, which events to subscribe to, and how to debug if it doesn't work.";

// Scenario 3: user has the wrong env var name set and asks why it doesn't work.
// Agent must (a) NOT recommend BITBUCKET_WEBHOOK_SECRET, (b) explain that for
// /hook/raw/ the secret is moot OR clarify the right env var name is plain
// `WEBHOOK_SECRET`.
//
// Phrasing intentionally vague about WHERE the var was set — workspace env
// vars are configured through the workspace (env_set via chat, the
// workspace's settings UI, or its workspace.yml `env:` block), not a
// fixed global path. The agent should not fixate on the path.
const USER_QUESTION_WRONG_ENV_VAR =
  "I set BITBUCKET_WEBHOOK_SECRET in my workspace's env vars and restarted, but my Bitbucket webhook still returns `missing x-hub-signature header`. What am I doing wrong?";

// Scenario 4: user describes the loop-trap symptom; agent should diagnose
// the comment-subscription loop and prescribe the guard.
const USER_QUESTION_LOOP_TRAP =
  "I built an agent that auto-replies 'ACK' to PR comments. It worked for the first comment but now it's posting ACK in an infinite loop on my PR — 18 comments and counting. What did I do wrong and how do I fix it?";

// Scenario 5: user reports a webhook that won't fire and wants to know where
// to start debugging. Agent must point at /status before guessing.
const USER_QUESTION_DEBUG_NO_FIRE =
  "I configured a Bitbucket webhook to hit my Friday workspace but nothing's happening when I push commits. Where do I start debugging?";

interface DriveResult {
  text: string;
  durationMs: number;
}

async function drive(
  systemPrompt: string,
  userMessage: string = USER_QUESTION_SETUP,
): Promise<DriveResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const startedAt = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? [])
    .filter(
      (b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n");
  return { text, durationMs: Date.now() - startedAt };
}

async function buildSystem(variant: "with-skill" | "without-skill"): Promise<string> {
  const prompt = await Deno.readTextFile(PROMPT_PATH);
  const parts = [prompt, WORKSPACE_SECTION, SKILL_INDEX_WITH_WIRING];
  if (variant === "with-skill") {
    // Simulate the runtime injecting the loaded skill content into the
    // chat — what happens after `load_skill` finishes successfully.
    const skill = await Deno.readTextFile(SKILL_PATH);
    parts.push(`<loaded_skill name="@friday/wiring-external-webhooks">\n${skill}\n</loaded_skill>`);
  }
  return parts.join("\n\n");
}

/**
 * Eight contract checks on the assistant's response text. Same checks as the
 * 2026-05-15 design — if any of these flip in the WITH-SKILL variant, the
 * skill stopped doing its job and Marc-class bugs are back.
 */
function runContractChecks(text: string): ContractCheck[] {
  const haystack = text.toLowerCase();
  const has = (needle: string) => haystack.includes(needle.toLowerCase());

  return [
    {
      id: "url-pattern",
      description: "mentions /hook/raw/{workspaceId}/{signalId} pattern",
      pass:
        /\/hook\/raw\/(light_papaya|\{?workspaceid\}?|<workspaceid>)/i.test(text) ||
        /\/hook\/raw\//.test(text),
      evidence: text.match(/\/hook\/raw\/[^\s)`]+/i)?.[0],
    },
    {
      id: "env-var-correct-or-absent",
      description:
        "if an env var for the webhook secret is mentioned, it's WEBHOOK_SECRET (not a provider-prefixed variant)",
      // Pass when EITHER: (a) WEBHOOK_SECRET appears with no wrong-prefixed variant,
      // OR (b) no env var is mentioned at all (e.g. raw-only flow with no secret).
      // Fail only when a wrong-prefixed variant appears as a recommendation.
      pass: !/(?:BITBUCKET|JIRA)_WEBHOOK_SECRET/.test(text),
      evidence: text.match(/[A-Z_]*WEBHOOK_SECRET[A-Z_]*/g)?.join(", ") || "(no env var mentioned)",
    },
    {
      id: "sig-header-or-raw-pass-through",
      description: "covers x-hub-signature OR notes raw drops headers (agent owns verify)",
      // The skill teaches: with /hook/raw/, the tunnel drops headers and the agent
      // does its own HMAC. So the response should either mention x-hub-signature
      // (for completeness) or explicitly say the raw provider doesn't verify.
      pass:
        has("x-hub-signature") ||
        /\b(?:raw|tunnel)\b[^.]*(?:no(?:t)?\s+verif|skip[s]?\s+verif|doesn'?t\s+verif|drops? headers)/i.test(
          text,
        ),
      evidence: text
        .match(/x-hub-signature[^\s.]*|(?:raw|tunnel)[^.]*?(?:verif|header)[^.]*/i)?.[0]
        ?.slice(0, 120),
    },
    {
      id: "event-allowlist",
      description:
        "mentions at least one bitbucket trigger the user can subscribe to (snake_case OR UI label)",
      // Accept either the wire-format event names (repo:push, pullrequest:created, etc.)
      // or Bitbucket's UI labels ("Build status created", "Push", "Pull request created").
      // Real responses tend to use the UI labels when walking through the trigger picker.
      pass:
        has("repo:push") ||
        has("pullrequest:created") ||
        has("pullrequest:comment") ||
        has("repo:commit_status") ||
        has("pullrequest:updated") ||
        /\bbuild status (?:created|updated)\b/i.test(text) ||
        /\bpull request (?:created|updated|approved|comment)/i.test(text) ||
        /\bpush\b.*(?:trigger|event|subscrib)/i.test(text),
      evidence: text
        .match(
          /(?:repo:|pullrequest:)[a-z_]+|Build status (?:created|updated)|Pull request (?:created|updated|approved|comment[\w_]+)/gi,
        )
        ?.slice(0, 4)
        .join(", "),
    },
    {
      id: "status-endpoint",
      description: "points at GET /status for debugging",
      pass: /\/status\b/.test(text),
      evidence: text.match(/[^\s]*\/status[^\s]*/)?.[0],
    },
    {
      id: "no-wrong-env-var",
      description: "does NOT suggest BITBUCKET_WEBHOOK_SECRET (Marc's footgun)",
      pass: !/BITBUCKET_WEBHOOK_SECRET/.test(text),
      evidence: text.match(/BITBUCKET_WEBHOOK_SECRET/)?.[0],
    },
    {
      id: "no-bogus-mappings-shape",
      description: "if a mappings file is suggested, uses providers: + mapping: (not extract:)",
      // Flag if the agent writes a mappings example using the Marc-shape
      // (top-level provider key without `providers:` wrapper, OR `extract:` instead of `mapping:`).
      pass: !(
        /webhook[-_]?mappings(\.json|\.yaml|\.yml)?/i.test(text) &&
        (/"extract"\s*:|\bextract\s*:/.test(text) ||
          (/"bitbucket"\s*:\s*[{(]|^[\s-]*bitbucket\s*:/m.test(text) &&
            !/^[\s-]*providers\s*:/m.test(text)))
      ),
      evidence: text
        .match(
          /(?:webhook-?mappings|"extract"|"providers"|\bextract\s*:|\bproviders\s*:|\bmapping\s*:)[^\n]{0,40}/gi,
        )
        ?.slice(0, 4)
        .join(" | "),
    },
    {
      id: "no-old-bitbucket-provider-url",
      description:
        "does NOT RECOMMEND the deprecated /hook/bitbucket/ URL (mentioning it in a deprecation/error context is fine)",
      // Fail only when the model presents /hook/bitbucket/ as a URL to use —
      // common shapes: "Use ...", "paste ...", code block, "URL:" line.
      // Pass when it appears alongside negative framing (removed, deprecated,
      // do not use, instead of, NOT, no longer, was removed, etc.).
      pass: (() => {
        const matches = [...text.matchAll(/(.{0,80}\/hook\/bitbucket\/[^\s)`]+.{0,80})/g)];
        if (matches.length === 0) return true;
        const negativeMarker =
          /\b(?:removed|deprecat|do not|don'?t use|no longer|wrong|incorrect|instead of|NOT use|migrat(?:ion|ing|e from)|old|legacy|previously|was)\b/i;
        // Pass only if EVERY occurrence is in a negative-framing context.
        return matches.every((m) => negativeMarker.test(m[1]));
      })(),
      evidence: text.match(/.{0,40}\/hook\/bitbucket\/[^\s)`]+.{0,40}/)?.[0]?.slice(0, 200),
    },
  ];
}

async function runVariant(variant: "with-skill" | "without-skill"): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log(`  → drive (${variant})`);
  const system = await buildSystem(variant);
  metrics.systemPromptLen = system.length;

  const result = await drive(system);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseHead = result.text.slice(0, 400);
  metrics.responseFull = result.text;

  const checks = runContractChecks(result.text);
  metrics.checks = checks;

  const failed = checks.filter((c) => !c.pass);
  const passed = checks.filter((c) => c.pass);
  metrics.passedCount = passed.length;
  metrics.failedCount = failed.length;

  if (variant === "with-skill") {
    // Positive case — must pass everything.
    if (failed.length === 0) {
      notes.push(`Positive: all ${checks.length} contract checks passed.`);
      for (const c of checks) {
        notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
      }
      return { id: variant, pass: true, notes, metrics };
    }
    notes.push(`Negative: ${failed.length}/${checks.length} contract checks failed.`);
    for (const c of checks) {
      notes.push(
        `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
      );
    }
    notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
    return { id: variant, pass: false, notes, metrics };
  }

  // without-skill (control): we expect at least one to fail. If none
  // fail, the skill isn't actually adding value (the model knows this
  // from training) — that's a meta-bug worth surfacing.
  if (failed.length === 0) {
    notes.push(
      `Negative-control passed all checks WITHOUT the skill — the skill isn't earning its keep. ` +
        `Either the contract is too lenient or the model already knows Friday's wiring. Tighten the checks.`,
    );
    for (const c of checks) {
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    }
    return { id: variant, pass: false, notes, metrics };
  }
  notes.push(
    `Negative-control failed ${failed.length}/${checks.length} as expected (skill is the carrier of this knowledge).`,
  );
  for (const c of checks) {
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  }
  return { id: variant, pass: true, notes, metrics };
}

// ───── Scenario 3: wrong-env-var correction ──────────────────────────────

async function runCorrectsWrongEnvVar(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (corrects-wrong-env-var)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_WRONG_ENV_VAR);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const checks: ContractCheck[] = [
    {
      id: "does-not-double-down-on-wrong-var",
      description:
        "Does NOT recommend setting BITBUCKET_WEBHOOK_SECRET (the var the user mentioned)",
      // The user said they set BITBUCKET_WEBHOOK_SECRET. The agent must not
      // tell them to keep using it / rename to a fresh provider-prefixed
      // variant / suggest a different but still-wrong form like
      // BITBUCKET_HOOK_SECRET. Pass when no recommended `set X` for any
      // BITBUCKET_*_SECRET-like name appears.
      pass: !/\b(?:set|use|try|change to|rename to|should be)\b[^\n]{0,60}BITBUCKET_[A-Z_]*SECRET/i.test(
        result.text,
      ),
      evidence: result.text.match(
        /\b(?:set|use|try|change to|rename to|should be)\b[^\n]{0,60}BITBUCKET_[A-Z_]*SECRET/i,
      )?.[0],
    },
    {
      id: "names-correct-var-or-says-not-needed",
      description:
        "Names WEBHOOK_SECRET (correct) OR explains the secret isn't needed for /hook/raw/",
      pass:
        /\bWEBHOOK_SECRET\b/.test(result.text) ||
        /\b(?:raw|tunnel)\b[^.]*(?:no(?:t)?\s+verif|doesn'?t\s+verif|don'?t need|leave blank|not required)/i.test(
          result.text,
        ),
      evidence: result.text
        .match(
          /\bWEBHOOK_SECRET\b|\b(?:raw|tunnel)\b[^.]*?(?:verif|leave blank|not required|don'?t need)[^.]*/i,
        )?.[0]
        ?.slice(0, 120),
    },
    {
      id: "diagnoses-real-problem",
      description:
        "Explains the user's real issue (the URL/path probably isn't /hook/raw/, or BITBUCKET_WEBHOOK_SECRET is not a Friday env var)",
      pass:
        /\bnot (?:a |an )?(?:friday|valid|recognized|real|known) env(?:ironment)? var/i.test(
          result.text,
        ) ||
        /\bisn'?t (?:read|recognized|used) by\b/i.test(result.text) ||
        /\bdoesn'?t exist\b/i.test(result.text) ||
        /\bsilently (?:ignor|not read)/i.test(result.text) ||
        /\/hook\/raw\//.test(result.text),
      evidence: result.text
        .match(
          /(?:not (?:a |an )?(?:friday|valid|recognized|real|known) env|isn'?t (?:read|recognized|used)|doesn'?t exist|silently ignor)[^\n]{0,80}|\/hook\/raw\/[^\s)`]+/i,
        )?.[0]
        ?.slice(0, 140),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "corrects-wrong-env-var", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "corrects-wrong-env-var", pass: false, notes, metrics };
}

// ───── Scenario 4: loop-trap diagnosis ───────────────────────────────────

async function runDiagnoseLoopTrap(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (diagnose-loop-trap)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_LOOP_TRAP);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const checks: ContractCheck[] = [
    {
      id: "identifies-comment-subscription-loop",
      description:
        "Identifies that subscribing to pullrequest:comment_created (the event the agent's own action creates) is the root cause",
      pass: /pullrequest:comment_created|comment[-_]?created|the comment event|your own comment[s]?|the agent'?s own (?:reply|comment)/i.test(
        result.text,
      ),
      evidence: result.text
        .match(
          /[^.\n]{0,80}(?:pullrequest:comment_created|comment[-_]?created|your own comment|the comment event)[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "prescribes-content-or-author-guard",
      description:
        "Prescribes either a content guard (skip if body == ACK) or an author guard (skip if commenter is the bot)",
      pass:
        /\b(?:skip|guard|check|ignore|filter)\b[^.\n]{0,80}\b(?:body|content|equals?\s*['"]?ACK|author|user|identity|self|own)/i.test(
          result.text,
        ) || /\bbefore (?:post|reply|sending)/i.test(result.text),
      evidence: result.text
        .match(
          /\b(?:skip|guard|check|ignore|filter)\b[^.\n]{0,80}\b(?:body|content|author|user|identity|self|own|ACK)[^.\n]{0,40}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "mentions-loop-mechanism",
      description:
        "Explains the mechanism: your comment fires the webhook → agent runs → posts again",
      pass: /\b(?:fires?|trigger|re-?fire|re-?trigger|loops? back|cycle|infinit|cascade)\b/i.test(
        result.text,
      ),
      evidence: result.text
        .match(
          /[^.\n]{0,80}\b(?:fires?|trigger|re-?fire|re-?trigger|loops? back|cycle|infinit|cascade)\b[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 200),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "diagnoses-loop-trap", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "diagnoses-loop-trap", pass: false, notes, metrics };
}

// ───── Scenario 5: points at /status first when debugging ────────────────

async function runPointsAtStatusFirst(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (points-at-status-first)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_DEBUG_NO_FIRE);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const checks: ContractCheck[] = [
    {
      id: "mentions-status-endpoint",
      description: "Mentions /status as a debugging entry point",
      pass: /\/status\b/.test(result.text),
      evidence: result.text.match(/[^\s]*\/status[^\s]*/)?.[0],
    },
    {
      id: "status-appears-near-top",
      description:
        "/status guidance is in the first half of the response (it should be the first thing to check)",
      pass: (() => {
        const idx = result.text.search(/\/status\b/);
        return idx >= 0 && idx < result.text.length * 0.6;
      })(),
      evidence: (() => {
        const idx = result.text.search(/\/status\b/);
        return idx >= 0
          ? `position ${idx} of ${result.text.length} (${Math.round((100 * idx) / result.text.length)}%)`
          : "(not found)";
      })(),
    },
    {
      id: "mentions-key-status-fields",
      description:
        "Explains what /status surfaces or actually invokes it (url, secret, providers, trycloudflare, or curl call)",
      // Pass when any of: /status appears in a hint about its output keys,
      // the response calls /status programmatically (run_code/curl/jq pattern),
      // or the response references the rotating trycloudflare URL behavior.
      pass:
        /\/status[^\n]{0,400}\b(?:url|secret|providers?)/i.test(result.text) ||
        /(?:tunnel )?url[^.\n]{0,80}(?:rotat|cloudflare|trycloudflare)/i.test(result.text) ||
        /(?:curl|run_code|jq)[^.\n]{0,80}\/status/i.test(result.text) ||
        /\b(?:tunnel )?providers?\b[^.\n]{0,40}(?:github|raw|active|registered)/i.test(result.text),
      evidence: result.text
        .match(
          /\/status[^\n]{0,200}|(?:url|secret|providers?)[^.\n]{0,80}(?:rotat|cloudflare|github|raw|registered)/i,
        )?.[0]
        ?.slice(0, 200),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "points-at-status-first", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "points-at-status-first", pass: false, notes, metrics };
}

// ────────────────────────────────────────────────────────────────────────
// Entrypoint
// ────────────────────────────────────────────────────────────────────────

async function main() {
  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  const writeResult = Deno.args.includes("--write-result");
  const jsonOutputArgIndex = Deno.args.indexOf("--json-output");
  const jsonOutputPath = jsonOutputArgIndex >= 0 ? Deno.args[jsonOutputArgIndex + 1] : undefined;
  const onlyArgIndex = Deno.args.indexOf("--only");
  const onlyId = onlyArgIndex >= 0 ? Deno.args[onlyArgIndex + 1] : undefined;
  if (jsonOutputArgIndex >= 0 && !jsonOutputPath) {
    console.error("--json-output requires a path");
    Deno.exit(2);
  }
  console.log(`▶ webhook-setup-bitbucket eval @ ${sha}`);

  const results: EvalResult[] = [];
  type Runner = () => Promise<EvalResult>;
  const runners: Array<{ id: string; fn: Runner }> = [
    { id: "with-skill", fn: () => runVariant("with-skill") },
    { id: "without-skill", fn: () => runVariant("without-skill") },
    { id: "corrects-wrong-env-var", fn: () => runCorrectsWrongEnvVar() },
    { id: "diagnoses-loop-trap", fn: () => runDiagnoseLoopTrap() },
    { id: "points-at-status-first", fn: () => runPointsAtStatusFirst() },
  ];

  for (const { id, fn } of runners) {
    if (onlyId && id !== onlyId) continue;
    console.log(`\n── ${id} ──`);
    try {
      results.push(await fn());
    } catch (err) {
      results.push({
        id,
        pass: false,
        notes: [`scenario threw: ${err instanceof Error ? err.message : String(err)}`],
        metrics: {},
      });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ webhook-setup-bitbucket summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const outPath =
      jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-webhook-setup-bitbucket.json`);
    await ensureDir(dirname(outPath));
    await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\n→ ${outPath}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
