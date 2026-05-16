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

// Scenario 7: user is writing their own forwarder/script that publishes a
// signal but doesn't want to hold its HTTP connection open while the
// cascade runs. Agent should recommend ?nowait=true and the 202 + SSE
// stream-by-correlationId pattern — that's exactly what the bus was
// designed for. Agent must NOT recommend long polling, raising the
// caller's HTTP timeout, or building a sidecar.
const USER_QUESTION_NOWAIT =
  "I'm writing a Python script that triggers a Friday signal. The signal kicks off a long job and my script doesn't need to wait for the result — it just needs to know the signal was accepted. What's the right way to do this without my script hanging on the HTTP call?";

// Scenario 8: user is calling the signal trigger PROGRAMMATICALLY in a
// loop and consuming the cascade's `output` + `summary` as input to the
// next iteration. Sync mode is the cleanest fit: one POST, one
// JSON envelope back, deterministic shape, no SSE parsing, no polling.
// Agent should recommend the default sync mode and NOT push SSE
// (overkill — streaming is for live progress, not programmatic
// consumption) and NOT push nowait + poll (overhead).
const USER_QUESTION_SYNC_OUTPUT =
  "I'm writing a Python script that triggers a Friday signal in a loop — 100 different payloads, sequentially, and my script parses each cascade's `output` and `summary` to drive the next iteration. The cascade usually completes in 5-10 seconds. What's the simplest endpoint to call so each iteration just blocks until done and returns the JSON?";

// Scenario 9: user wants real-time progress visibility for a long-
// running cascade (debugging UI, log tail, watching steps as they happen).
// Agent should recommend SSE — either Accept: text/event-stream on the
// trigger (one POST, streams), OR ?nowait=true then GET /signals/stream/
// {correlationId} (two requests, publisher and watcher can be different
// processes). Agent must NOT recommend polling, must NOT recommend the
// sync JSON mode and then "parse the output for progress" (output is
// only available at completion).
const USER_QUESTION_PROGRESS_STREAM =
  "I'm building a debugging UI that fires a Friday signal and shows the agent's progress as it runs — step by step, tool calls as they happen, not just the final output. What endpoint should I hit?";

// Scenario 10: user asks which webhook providers Friday supports. The
// skill teaches the current truth: [github, raw]. Negative-polarity:
// the response must NOT (a) list bitbucket / jira as built-in
// providers, (b) cite a specific removal date (skill content was
// audited to remove dated 2026-05-15 references — if any leaks in,
// fail), (c) recommend WEBHOOK_MAPPINGS_PATH as a way to register
// bitbucket/jira (it's a github-only override).
const USER_QUESTION_PROVIDER_LIST =
  "Which webhook providers does Friday's webhook-tunnel support out of the box? I'm trying to figure out what URLs are valid for /hook/<provider>/...";

// Scenario 11: user wants HMAC signature verification for a Bitbucket
// webhook. The skill teaches: WEBHOOK_SECRET is github-only; for
// bitbucket you do the HMAC in the agent code using a different env
// var name (must NOT collide with WEBHOOK_SECRET). Negative-polarity:
// agent must not (a) tell the user to set WEBHOOK_SECRET for
// bitbucket, (b) claim Friday verifies the signature for them via
// /hook/raw/, (c) recommend the deprecated /hook/bitbucket/ as a way
// to get signature verification.
const USER_QUESTION_BITBUCKET_HMAC =
  "I need HMAC signature verification on my Bitbucket webhook to my Friday workspace — I don't want random people POSTing to the public tunnel URL. How do I set it up?";

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
      // or Bitbucket's UI labels. The UI shows synonyms — "Build status created" /
      // "Commit status created" both refer to repo:commit_status_created in different
      // panes of Bitbucket Cloud. Real responses use whatever label the model has seen.
      pass:
        has("repo:push") ||
        has("pullrequest:created") ||
        has("pullrequest:comment") ||
        has("repo:commit_status") ||
        has("pullrequest:updated") ||
        /\b(?:build|commit) status (?:created|updated)\b/i.test(text) ||
        /\bpull request (?:created|updated|approved|comment)/i.test(text) ||
        /\bpush\b.*(?:trigger|event|subscrib)/i.test(text),
      evidence: text
        .match(
          /(?:repo:|pullrequest:)[a-z_]+|(?:Build|Commit) status (?:created|updated)|Pull request (?:created|updated|approved|comment[\w_]+)/gi,
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
        return matches.every((m) => negativeMarker.test(m[1] ?? m[0]));
      })(),
      evidence: text.match(/.{0,40}\/hook\/bitbucket\/[^\s)`]+.{0,40}/)?.[0]?.slice(0, 200),
    },
    {
      id: "no-atlasd-direct-path",
      description:
        "does NOT recommend /api/workspaces/.../signals/<id> as the webhook URL (atlasd's internal direct path)",
      // Marc's chat dump message #0: first URL he was given was atlasd's
      // direct signal endpoint. Tunnel returns 404 for non-/hook/ paths.
      // Pass when the only `/api/workspaces/.../signals/...` URLs are:
      //   - on the tunnel (port 9090) and end in /history or /status
      //     (read-only introspection endpoints — harmless to mention)
      //   - in a "do not use" / "wrong" / "atlasd's internal" framing
      pass: (() => {
        const matches = [
          ...text.matchAll(/(.{0,80}\/api\/workspaces\/[^/\s]+\/signals\/[^\s)`]*.{0,80})/g),
        ];
        if (matches.length === 0) return true;
        const negativeMarker =
          /\b(?:do not|don'?t use|wrong|incorrect|atlasd'?s|internal|NOT (?:use|reach)|404|not reachable|don'?t (?:point|hit))\b/i;
        const tunnelIntrospection = /\/(?:history|status)(?:\?|$|\s|\))/;
        return matches.every(
          (m) => negativeMarker.test(m[1] ?? m[0]) || tunnelIntrospection.test(m[1] ?? m[0]),
        );
      })(),
      evidence: text.match(/[^\s]*\/api\/workspaces\/[^/\s]+\/signals\/[^\s)`]*/)?.[0],
    },
    {
      id: "no-python-sidecar-recommendation",
      description:
        "does NOT recommend writing a Python/Node sidecar webhook receiver — the bundled tunnel IS the receiver",
      // Marc's chat: the agent eventually built him a Python script to
      // intermediate Bitbucket → Friday. Anything pointing at "write your
      // own HTTP server" / "spin up a Flask/FastAPI/express receiver" /
      // "run a Python script alongside" is back to that failure mode.
      pass:
        !/(?:flask|fastapi|express|http\.server)\b[^\n.]{0,80}(?:server|listener|sidecar|forwarder|receiver|intermediate)/i.test(
          text,
        ) &&
        !/(?:write|build|run|spin up|create|set up)\s+(?:a |an |your own )?(?:python|node|flask|fastapi|express|http) (?:server|listener|sidecar|forwarder|receiver|script|app|service)\b/i.test(
          text,
        ),
      evidence: text
        .match(
          /(?:flask|fastapi|express|http\.server)\b[^\n.]{0,60}(?:server|listener|sidecar|forwarder|receiver|intermediate)|(?:write|build|run|spin up|create|set up)\s+(?:a |an |your own )?[^.\n]{0,40}(?:server|listener|sidecar|forwarder|receiver|script|app|service)/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      id: "no-handrolled-tunnel-setup",
      description:
        "does NOT tell user to install/run cloudflared / ngrok / their own tunnel — the daemon bundles it",
      pass: !/\b(?:install|brew install|download|set up|setup|run|spawn|start)\b[^.\n]{0,60}\b(?:cloudflared|ngrok|tailscale funnel|localtunnel|serveo)\b/i.test(
        text,
      ),
      evidence: text.match(
        /\b(?:install|brew install|download|set up|setup|run|spawn|start)\b[^.\n]{0,60}\b(?:cloudflared|ngrok|tailscale funnel|localtunnel|serveo)\b/i,
      )?.[0],
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
    {
      id: "no-jira-or-github-prefixed-alt",
      description:
        "does NOT suggest a different provider-prefixed alternative like JIRA_WEBHOOK_SECRET / GITHUB_WEBHOOK_SECRET / BITBUCKET_HOOK_SECRET",
      pass:
        !/\b(?:JIRA|GITHUB|BITBUCKET)_(?:WEBHOOK|HOOK)_(?:SECRET|TOKEN|KEY)\b/.test(result.text) ||
        // tolerate mentions when every occurrence is in negative framing —
        // explaining what the user did wrong, telling them to remove the
        // var, or naming a custom-prefixed alternative
        (() => {
          const lines = result.text.split(/\n/);
          const violations = lines.filter((l) =>
            /\b(?:JIRA|GITHUB|BITBUCKET)_(?:WEBHOOK|HOOK)_(?:SECRET|TOKEN|KEY)\b/.test(l),
          );
          // pass if every mention is in negative framing
          const neg =
            /\b(?:not|don'?t|do not|never|doesn'?t exist|isn'?t|wrong|invalid|silently|remove|removed|unset|delete|ignor(?:e|ed)|won'?t|cannot|can'?t|NOT\s+`?WEBHOOK_SECRET`?)\b/i;
          return violations.length > 0 && violations.every((l) => neg.test(l));
        })(),
      evidence: result.text
        .match(/\b(?:JIRA|GITHUB|BITBUCKET)_(?:WEBHOOK|HOOK)_(?:SECRET|TOKEN|KEY)\b/g)
        ?.slice(0, 5)
        .join(", "),
    },
    {
      id: "no-blames-restart",
      description:
        "does NOT pin the bug on user's restart sequence (the real bug is the wrong env var name, not how they restarted)",
      // Some models try to blame restart timing ("you need to restart the
      // tunnel separately", "the daemon caches env vars in memory"). For
      // the wrong-env-var case the restart isn't the bug — the var doesn't
      // exist at all.
      pass:
        !/\b(?:restart|reload|reboot)\b[^.\n]{0,80}(?:in (?:the )?wrong order|sequence|first|both|tunnel separately|incorrectly|properly)/i.test(
          result.text,
        ) && !/\b(?:tunnel|daemon)\b[^.\n]{0,30}(?:caches|cached|stale)\s+env/i.test(result.text),
      evidence: result.text
        .match(
          /\b(?:restart|reload|reboot)\b[^.\n]{0,80}(?:wrong|sequence|first|both|separately|incorrectly|properly)|\b(?:tunnel|daemon)\b[^.\n]{0,30}(?:caches|cached|stale)\s+env/i,
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
    {
      id: "no-sleep-or-rate-limit-remedy",
      description:
        "does NOT prescribe a sleep / rate-limit / debounce as the fix (those don't break the cycle, they just slow it)",
      // Wrong remedies seen in prior drafts: "add a 5-second sleep before
      // posting", "rate-limit to 1 comment per minute", "debounce".
      // None of these stop the loop — they just delay it.
      pass:
        !/\b(?:add|insert|use|with)\s+(?:a |an )?(?:sleep|delay|debounce|rate[\s-]?limit|throttle|backoff)\b[^.\n]{0,60}(?:between|before|to (?:slow|prevent|fix|stop)|to avoid)/i.test(
          result.text,
        ) &&
        !/\b(?:rate[\s-]?limit|throttle|debounce)\b[^.\n]{0,40}\b(?:to (?:fix|stop|prevent|avoid|break)|will (?:fix|stop|prevent|avoid|break))\b/i.test(
          result.text,
        ),
      evidence: result.text
        .match(
          /\b(?:add|insert|use|with)\s+(?:a |an )?(?:sleep|delay|debounce|rate[\s-]?limit|throttle|backoff)\b[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      id: "no-just-unsubscribe-as-only-fix",
      description:
        "does NOT make 'just unsubscribe from comment events entirely' the ONLY fix without acknowledging that's giving up on the use case",
      // Telling the user to drop comment-event handling is a regression of
      // capability, not a fix. A correct answer offers the guard pattern;
      // dropping the subscription can be mentioned as a fallback but not
      // as the only option.
      pass: (() => {
        const dropMatch =
          /\b(?:unsubscribe|remove|drop|don'?t subscribe|stop subscribing|skip subscribing)\b[^.\n]{0,80}\bpullrequest:?comment/i.test(
            result.text,
          );
        if (!dropMatch) return true;
        // Pass if the response ALSO prescribes a guard pattern (means it's offering both).
        return /\b(?:guard|skip|check|filter|ignore)\b[^.\n]{0,80}\b(?:body|content|author|user|identity|self|own|ACK)/i.test(
          result.text,
        );
      })(),
      evidence: result.text
        .match(
          /\b(?:unsubscribe|remove|drop|don'?t subscribe|stop subscribing)\b[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      id: "no-just-delete-spam-as-fix",
      description:
        "does NOT make 'delete the spam comments' a remedy (cleanup ≠ fix; root cause must be addressed first)",
      pass: !/\b(?:delete|remove|clean up|cleanup)\b[^.\n]{0,40}(?:the )?(?:spam|loop|18|extra|duplicate|repeated) (?:comments?)\b[^.\n]{0,80}(?:to (?:fix|stop|prevent)|will (?:fix|stop|prevent)|solves?|resolves?)/i.test(
        result.text,
      ),
      evidence: result.text
        .match(
          /\b(?:delete|remove|clean up|cleanup)\b[^.\n]{0,40}(?:the )?(?:spam|loop|18|extra|duplicate|repeated) comment[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 160),
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
    {
      id: "no-restart-as-first-step",
      description:
        "does NOT suggest restarting the daemon as the first debug step (real first step is /status)",
      // Pin the negative: a restart instruction in the first 25% of the
      // response means the agent went to "did you try turning it off and
      // on" before looking at /status. Restart later in the response is
      // fine (it's the right fix for stale env vars).
      pass: (() => {
        const restartIdx = result.text
          .toLowerCase()
          .search(
            /\b(?:restart|reboot|kill (?:and )?start)\s+(?:the )?(?:daemon|tunnel|atlasd|friday|server)\b/,
          );
        if (restartIdx < 0) return true;
        return restartIdx > result.text.length * 0.25;
      })(),
      evidence: (() => {
        const idx = result.text
          .toLowerCase()
          .search(
            /\b(?:restart|reboot|kill (?:and )?start)\s+(?:the )?(?:daemon|tunnel|atlasd|friday|server)\b/,
          );
        return idx >= 0
          ? `restart at position ${idx} of ${result.text.length} (${Math.round((100 * idx) / result.text.length)}%)`
          : "(no restart suggested)";
      })(),
    },
    {
      id: "no-curl-localhost-as-test",
      description:
        "does NOT recommend curl-ing localhost:9090/hook/ directly as the way to test (that bypasses cloudflared, doesn't test the real wire)",
      // Hitting the local port directly skips the cloudflared edge — so
      // the test passes even when the public webhook URL is broken. The
      // useful test goes through the public trycloudflare URL.
      pass:
        !/\b(?:curl|wget|http)\b[^.\n]{0,40}(?:localhost|127\.0\.0\.1)(?::9090|:8080)\/hook\//i.test(
          result.text,
        ) &&
        !/\b(?:test|verify|check)\b[^.\n]{0,40}(?:by )?\b(?:curl|wget)ing\s+(?:localhost|127\.0\.0\.1)/i.test(
          result.text,
        ),
      evidence: result.text.match(
        /\b(?:curl|wget|http)\b[^.\n]{0,60}(?:localhost|127\.0\.0\.1)(?::\d+)?\/hook\/[^\s)`]+/i,
      )?.[0],
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

// ───── Scenario 6: test-the-webhook negative-leaning ─────────────────────

const USER_QUESTION_TEST_WEBHOOK =
  "How do I test that my Bitbucket webhook is wired up correctly without waiting for a real PR comment?";

async function runTestWebhookNegativeCheck(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (test-webhook-no-bypass)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_TEST_WEBHOOK);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const checks: ContractCheck[] = [
    // Positive — must offer SOME way to test
    {
      id: "offers-test-mechanism",
      description:
        "Offers some concrete way to test (curl through tunnel, Bitbucket Test connectivity, signal trigger via CLI)",
      pass:
        /\bcurl\b/i.test(result.text) ||
        /\btrigger\b/i.test(result.text) ||
        /\btest connectivity\b/i.test(result.text) ||
        /\bresend\b/i.test(result.text) ||
        /\battlas signal/i.test(result.text) ||
        /\bview requests\b/i.test(result.text),
      evidence: result.text
        .match(
          /\bcurl\b[^.\n]{0,80}|\btrigger\b[^.\n]{0,60}|\bTest connectivity\b|\bResend\b|\bView requests\b/i,
        )?.[0]
        ?.slice(0, 160),
    },
    // Negative — must NOT recommend the wrong bypass / sidecar shapes
    {
      id: "no-localhost-bypass",
      description:
        "does NOT recommend curl-ing localhost:9090/hook/ (bypasses cloudflared, doesn't test the real public path)",
      pass: !/\b(?:curl|wget)\b[^.\n]{0,40}(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?\/hook\//i.test(
        result.text,
      ),
      evidence: result.text.match(
        /\b(?:curl|wget)\b[^.\n]{0,60}(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?\/hook\/[^\s)`]+/i,
      )?.[0],
    },
    {
      id: "no-sidecar-recommendation",
      description: "does NOT suggest standing up a Python/Node script as a stand-in receiver",
      pass: !/(?:write|build|run|spin up|create|set up)\s+(?:a |an |your own )?(?:python|node|flask|fastapi|express|http) (?:server|listener|sidecar|forwarder|receiver|script|app|service)\b/i.test(
        result.text,
      ),
      evidence: result.text
        .match(
          /(?:write|build|run|spin up|create|set up)\s+(?:a |an |your own )?[^.\n]{0,50}(?:server|listener|sidecar|forwarder|receiver|script|service)/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      id: "no-fake-event-name",
      description:
        "does NOT invent Bitbucket event names that don't exist (e.g. pullrequest:merged is fake — real name is pullrequest:fulfilled)",
      // Real Bitbucket Cloud event names per `pullrequest:` prefix. Anything
      // outside this set is hallucinated. Limit to common-hallucination forms.
      pass:
        !/pullrequest:merged\b/i.test(result.text) &&
        !/pullrequest:closed\b/i.test(result.text) &&
        !/pullrequest:opened\b/i.test(result.text) &&
        !/repo:commit\b(?![:_])/i.test(result.text),
      evidence: result.text.match(/pullrequest:(?:merged|closed|opened)|repo:commit\b/i)?.[0],
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "test-webhook-no-bypass", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "test-webhook-no-bypass", pass: false, notes, metrics };
}

// ───── Scenario 7: fire-and-forget signal trigger (?nowait=true) ─────────

async function runNowaitRecommendation(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (nowait-recommendation)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_NOWAIT);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const checks: ContractCheck[] = [
    // Positive — must surface the right knob
    {
      id: "recommends-nowait-query-param",
      description: "Recommends ?nowait=true (or wait=false) as the fire-and-forget knob",
      pass: /\?nowait=true\b|\?wait=false\b|\bnowait[:= ]true\b/i.test(result.text),
      evidence: result.text.match(/\?nowait=true\b|\?wait=false\b|\bnowait[:= ]true\b/i)?.[0],
    },
    {
      id: "explains-202-response-shape",
      description:
        "Explains that the response is 202 / 'accepted' with a correlationId — not 200 with output",
      pass:
        /\b202\b/.test(result.text) ||
        /\baccepted\b[^.\n]{0,80}\b(?:correlationId|correlation id|stream url)/i.test(
          result.text,
        ) ||
        /\bcorrelationId\b/i.test(result.text),
      evidence: result.text
        .match(/\b202\b|\baccepted\b[^.\n]{0,80}|\bcorrelationId\b/i)?.[0]
        ?.slice(0, 120),
    },
    // Negative — must NOT recommend the wrong workarounds
    {
      id: "no-raise-timeout-recommendation",
      description:
        "Does NOT recommend raising the caller's HTTP timeout as the fix (that doesn't make it fire-and-forget; it just defers the problem)",
      pass:
        !/\b(?:raise|increase|bump|extend|lengthen|set)\b[^.\n]{0,40}\b(?:timeout|deadline)\b[^.\n]{0,40}\b(?:client|request|requests|http|connection)/i.test(
          result.text,
        ) &&
        !/\b(?:client|request|http)\s+timeout\b[^.\n]{0,40}\b(?:longer|higher|increase|raise|bump)/i.test(
          result.text,
        ),
      evidence: result.text
        .match(
          /\b(?:raise|increase|bump|extend|lengthen)\b[^.\n]{0,80}\b(?:timeout|deadline)\b[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      id: "no-long-polling-recommendation",
      description: "Does NOT recommend long-polling or repeatedly hitting the sync endpoint",
      pass:
        !/\blong[\s-]?poll(?:ing)?\b/i.test(result.text) &&
        !/\b(?:retry|poll|repeat)\b[^.\n]{0,40}\b(?:request|the call|the trigger|POST)\b[^.\n]{0,40}\b(?:until|while)\b/i.test(
          result.text,
        ),
      evidence: result.text
        .match(/\blong[\s-]?poll(?:ing)?\b|(?:retry|poll|repeat)[^.\n]{0,80}(?:until|while)/i)?.[0]
        ?.slice(0, 160),
    },
    {
      id: "no-sidecar-recommendation",
      description: "Does NOT recommend a Python/Node sidecar / threading / subprocess workaround",
      pass:
        !/(?:thread|subprocess|fork|background)\s+(?:the|your)\s+(?:request|call|trigger|HTTP|POST)/i.test(
          result.text,
        ) &&
        !/(?:write|build|run|spin up|create)\s+(?:a |an |your own )?[^.\n]{0,40}(?:sidecar|forwarder|wrapper script)/i.test(
          result.text,
        ),
      evidence: result.text
        .match(
          /(?:thread|subprocess|fork|background)[^.\n]{0,80}(?:request|call|trigger|HTTP|POST)|(?:sidecar|forwarder|wrapper script)/i,
        )?.[0]
        ?.slice(0, 160),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "recommends-nowait-pattern", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "recommends-nowait-pattern", pass: false, notes, metrics };
}

// ───── Scenario 8: sync JSON when caller needs cascade output ────────────

async function runRecommendsSyncForOutput(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (recommends-sync-for-output)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_SYNC_OUTPUT);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const checks: ContractCheck[] = [
    // Positive — sync mode is the right answer here
    {
      id: "recommends-sync-default",
      description:
        "Recommends the default sync mode — POST without ?nowait, response includes the cascade output",
      pass: (() => {
        // Markdown asterisks/backticks shouldn't break the "without nowait" detection.
        // Strip them before pattern-matching.
        const plain = result.text.replace(/[*_`]/g, "");
        const recommendsSync =
          /\b(?:default|sync(?:hronous|hronous mode|hronous response)?|just POST|simple POST)\b/i.test(
            plain,
          ) ||
          /\bwithout\s+\??nowait/i.test(plain) ||
          /\bno\s+\??nowait\b/i.test(plain) ||
          /\bomit\s+\??nowait\b/i.test(plain);
        // And evidence the response will contain the cascade fields
        const explainsShape =
          /\b(?:output|summary|sessionId|artifactIds|result)\b[^.\n]{0,80}\b(?:back|in (?:the )?response|return[s]?|response includes|response has|response contains|has )/i.test(
            plain,
          ) ||
          /\b(?:response|envelope|json|payload)\b[^.\n]{0,80}\b(?:has|includes|contains)\b[^.\n]{0,80}\b(?:output|summary|sessionId|artifactIds)/i.test(
            plain,
          ) ||
          /\bresult\.(?:output|summary|sessionId|artifactIds)/i.test(plain);
        return recommendsSync && explainsShape;
      })(),
      evidence: result.text
        .match(/\b(?:default|sync(?:hronous)?|without|no|omit)\b[^.\n]{0,160}/i)?.[0]
        ?.slice(0, 200),
    },
    {
      id: "explains-response-shape",
      description:
        "Explains the response shape (200 / completed / output / summary / sessionId fields)",
      pass:
        /\b200\b/.test(result.text) ||
        /\bcompleted\b/i.test(result.text) ||
        /\boutput\b/i.test(result.text) ||
        /\bsummary\b/i.test(result.text) ||
        /\bsessionId\b/i.test(result.text),
      evidence: result.text
        .match(/\b(?:200|completed|output|summary|sessionId)[^.\n]{0,80}/i)?.[0]
        ?.slice(0, 120),
    },
    // Negative — don't push nowait+poll for a use case that just needs the synchronous response
    {
      id: "no-nowait-as-primary-recommendation",
      description:
        "Does NOT push ?nowait=true as the primary path (the user wants the response, not a correlationId)",
      pass: (() => {
        // Fail only when nowait appears as an active recommendation —
        // imperative verb pointed at nowait ("use ?nowait=true", "POST with
        // ?nowait=true", "add ?nowait=true to your URL"). Tolerate
        // mentions in contrast / description / "or use nowait if X" /
        // mode-enumeration contexts.
        const recommendationPatterns = [
          /\b(?:use|set|add|append|pass|send|include|post with|fire with|trigger with|append to (?:the )?url|recommend(?:ed)? (?:using )?)\s+`?\??nowait(?:=true)?\b/i,
          /\b(?:should|need to|must|have to)\s+(?:use|set|add|pass|include|append)\b[^.\n]{0,40}\?nowait/i,
          /\bI(?:'?d|\s+would)?\s+recommend\b[^.\n]{0,40}\?nowait/i,
          /\bthe\s+(?:right|correct|best|simplest|cleanest)\s+(?:way|approach|endpoint|mode)\b[^.\n]{0,60}\?nowait/i,
        ];
        return !recommendationPatterns.some((p) => p.test(result.text));
      })(),
      evidence: result.text.match(/[^.\n]{0,40}\bnowait[^.\n]{0,80}/i)?.[0]?.slice(0, 160),
    },
    {
      id: "no-poll-after-trigger",
      description:
        "Does NOT recommend trigger-then-poll (the sync default already blocks; polling is redundant)",
      pass: !/\b(?:trigger|fire|publish|POST)\b[^.\n]{0,40}\b(?:then|after|and)\b[^.\n]{0,40}\bpoll(?:ing)?\b/i.test(
        result.text,
      ),
      evidence: result.text.match(
        /\b(?:trigger|fire|publish|POST)\b[^.\n]{0,60}\b(?:then|after|and)\b[^.\n]{0,40}\bpoll(?:ing)?\b[^.\n]{0,60}/i,
      )?.[0],
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "recommends-sync-for-output", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "recommends-sync-for-output", pass: false, notes, metrics };
}

// ───── Scenario 9: SSE for live progress ─────────────────────────────────

async function runRecommendsSseForProgress(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (recommends-sse-for-progress)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_PROGRESS_STREAM);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const checks: ContractCheck[] = [
    // Positive — SSE is the right answer
    {
      id: "recommends-sse-or-event-stream",
      description:
        "Recommends SSE — Accept: text/event-stream on the trigger OR GET /signals/stream/{correlationId}",
      pass:
        /\btext\/event-stream\b/i.test(result.text) ||
        /\bSSE\b/.test(result.text) ||
        /\bserver[-\s]?sent\s+events\b/i.test(result.text) ||
        /\/signals\/stream\//i.test(result.text),
      evidence: result.text.match(
        /\btext\/event-stream\b|\bSSE\b|\bserver[-\s]?sent\s+events\b|\/signals\/stream\/[^\s)`]+/i,
      )?.[0],
    },
    {
      id: "explains-streaming-mechanism",
      description:
        "Explains the streaming mechanism (chunks/data:/events arriving as the cascade runs)",
      pass:
        /\b(?:chunk|data:|event[s]?\s+(?:as|arriv|stream))\b/i.test(result.text) ||
        /\bstream(?:s|ing|ed)?\b[^.\n]{0,80}\b(?:as|while|during|in real[\s-]?time|live)\b/i.test(
          result.text,
        ),
      evidence: result.text
        .match(/\b(?:chunk|data:|stream(?:s|ing)?\b[^.\n]{0,80})/i)?.[0]
        ?.slice(0, 160),
    },
    // Negative
    {
      id: "no-polling-recommendation",
      description: "Does NOT recommend polling (SSE replaces the need to poll)",
      pass:
        !/\bpoll(?:ing)?\b[^.\n]{0,80}\b(?:every|each|interval|second|loop|fetch)/i.test(
          result.text,
        ) && !/\b(?:loop|repeat)\b[^.\n]{0,40}\b(?:fetch|GET|request)\b/i.test(result.text),
      evidence: result.text.match(
        /\bpoll(?:ing)?\b[^.\n]{0,80}(?:every|each|interval|second|loop|fetch)/i,
      )?.[0],
    },
    {
      id: "no-sync-then-parse-for-progress",
      description:
        "Does NOT recommend calling the sync JSON endpoint and parsing its output for progress (output is only available at completion)",
      pass: !/\b(?:sync(?:hronous)?|default|JSON)\b[^.\n]{0,80}\b(?:parse|extract|read|inspect)\b[^.\n]{0,40}\b(?:output|response|result)\b[^.\n]{0,40}\b(?:for|to (?:get|see|watch))\b[^.\n]{0,40}\bprogress\b/i.test(
        result.text,
      ),
      evidence: result.text
        .match(
          /\b(?:sync|default|JSON)\b[^.\n]{0,80}\b(?:parse|extract|read)\b[^.\n]{0,80}\bprogress\b/i,
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
    return { id: "recommends-sse-for-progress", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "recommends-sse-for-progress", pass: false, notes, metrics };
}

// ───── Scenario 10: provider-list correctness ────────────────────────────

async function runProviderList(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (lists-current-providers)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_PROVIDER_LIST);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "names-github-and-raw",
      description: "Names both `github` and `raw` as the available providers",
      pass: /\bgithub\b/i.test(text) && /\braw\b/i.test(text),
      evidence: text.match(/\bgithub\b[^\n.]{0,40}\braw\b|\braw\b[^\n.]{0,40}\bgithub\b/i)?.[0],
    },
    {
      id: "does-not-list-bitbucket-as-builtin",
      description:
        "Does NOT present `bitbucket` as a built-in provider — must route Bitbucket through /hook/raw/",
      // Fail only when bitbucket is enumerated as a CURRENT built-in
      // (e.g. "providers: github, bitbucket, raw" or `["github","bitbucket","raw"]`).
      // Pass when bitbucket appears in negative framing ("removed",
      // "deprecated"), in "use raw for bitbucket" instructions, or as a
      // capitalized noun referring to the SaaS product.
      pass: (() => {
        // Walk every snippet around a bitbucket mention; fail only when at
        // least one is in a built-in-enumeration context with no negative
        // marker on the same line.
        const matches = [...text.matchAll(/(.{0,80}\bbitbucket\b.{0,80})/gi)];
        if (matches.length === 0) return true;
        const enumerationContext =
          /providers?\s*(?:are|:|include[s]?|list|registered)|\[[^\]]*\]|`(?:github|raw)`\s*(?:,|\sand\s)\s*`?bitbucket`?|`bitbucket`\s*(?:,|\sand\s)\s*`(?:github|raw)`/i;
        const negativeMarker =
          /\b(?:removed|deprecat|do not|don'?t|no longer|wrong|incorrect|NOT|legacy|previously|was|goes through|use\s+(?:the\s+)?raw|via\s+(?:the\s+)?raw|through\s+(?:the\s+)?raw|\/hook\/raw\/|isn'?t|aren'?t|dedicated\s+bitbucket\b)\b/i;
        // bitbucket-as-builtin requires enumeration AND no negative marker
        return !matches.some((m) => {
          const ctx = m[1] ?? m[0];
          return enumerationContext.test(ctx) && !negativeMarker.test(ctx);
        });
      })(),
      evidence: text
        .match(
          /providers?\s*(?:are|:|include[s]?)\s*[^.\n]{0,160}|.{0,80}\bbitbucket\b.{0,80}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "does-not-list-jira-as-builtin",
      description: "Does NOT present `jira` as a built-in provider",
      pass: (() => {
        const matches = [...text.matchAll(/(.{0,80}\bjira\b.{0,80})/gi)];
        if (matches.length === 0) return true;
        const enumerationContext =
          /providers?\s*(?:are|:|include[s]?|list|registered)|\[[^\]]*\]|`(?:github|raw)`\s*(?:,|\sand\s)\s*`?jira`?|`jira`\s*(?:,|\sand\s)\s*`(?:github|raw)`/i;
        const negativeMarker =
          /\b(?:removed|deprecat|do not|don'?t|no longer|wrong|incorrect|NOT|legacy|previously|was|goes through|use\s+(?:the\s+)?raw|via\s+(?:the\s+)?raw|through\s+(?:the\s+)?raw|\/hook\/raw\/|isn'?t|aren'?t|dedicated\s+jira\b)\b/i;
        return !matches.some((m) => {
          const ctx = m[1] ?? m[0];
          return enumerationContext.test(ctx) && !negativeMarker.test(ctx);
        });
      })(),
      evidence: text
        .match(/providers?\s*(?:are|:|include[s]?)\s*[^.\n]{0,160}|.{0,80}\bjira\b.{0,80}/i)?.[0]
        ?.slice(0, 200),
    },
    {
      id: "no-dated-removal-claim",
      description:
        "Does NOT cite a specific date for bitbucket/jira removal (the skill was audited to drop dated refs)",
      // Fail if the response contains "removed on YYYY-MM-DD" or "removed in
      // <month> <year>" or "as of <date>". The skill content shouldn't be
      // sneaking dates back into the answer.
      pass:
        !/removed\s+(?:on|in)\s+\d{4}-\d{2}-\d{2}/i.test(text) &&
        !/removed\s+(?:on|in)\s+\w+\s+\d{4}/i.test(text) &&
        !/as of\s+\d{4}-\d{2}-\d{2}/i.test(text),
      evidence: text.match(
        /removed\s+(?:on|in)\s+(?:\d{4}-\d{2}-\d{2}|\w+\s+\d{4})|as of\s+\d{4}-\d{2}-\d{2}/i,
      )?.[0],
    },
    {
      id: "no-webhook-mappings-for-bitbucket",
      description:
        "Does NOT recommend WEBHOOK_MAPPINGS_PATH as a way to register bitbucket/jira (it's a github-only override)",
      // Fail if the answer pairs WEBHOOK_MAPPINGS_PATH with bitbucket or jira
      // in a "use this to add support" context.
      pass: !(
        /WEBHOOK_MAPPINGS_PATH/.test(text) &&
        /\b(?:bitbucket|jira)\b/i.test(text) &&
        /\b(?:add|register|enable|support|provider for)\b/i.test(text) &&
        // tolerate negative framing ("WEBHOOK_MAPPINGS_PATH is NOT a way to register bitbucket")
        !/\bNOT\s+(?:a\s+way|how|the way|for|to register|to enable)\b/i.test(text)
      ),
      evidence: text
        .match(
          /WEBHOOK_MAPPINGS_PATH[^\n.]{0,120}\b(?:bitbucket|jira)\b|[^.\n]{0,80}WEBHOOK_MAPPINGS_PATH[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "mentions-hook-raw-for-bitbucket",
      description: "Explains bitbucket / other providers use /hook/raw/",
      pass:
        /\/hook\/raw\b/.test(text) ||
        /\braw\b[^.\n]{0,60}\b(?:bitbucket|jira|custom|other)/i.test(text) ||
        /\bbitbucket\b[^.\n]{0,60}\b(?:goes through|use[s]?|via|through)\b[^.\n]{0,30}\braw\b/i.test(
          text,
        ),
      evidence: text
        .match(/\/hook\/raw\/[^\s)`]*|\b(?:bitbucket|jira)[^.\n]{0,80}\braw\b[^.\n]{0,40}/i)?.[0]
        ?.slice(0, 200),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "lists-current-providers", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "lists-current-providers", pass: false, notes, metrics };
}

// ───── Scenario 11: bitbucket HMAC must be agent-side ─────────────────────

async function runBitbucketHmacInAgent(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (bitbucket-hmac-in-agent)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_BITBUCKET_HMAC);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "explains-raw-does-not-verify",
      description:
        "Explains that the raw provider doesn't verify the signature (so the agent must)",
      pass:
        /\b(?:raw|tunnel)\b[^.]*(?:no(?:t)?\s+verif|doesn'?t\s+verif|drops? headers|skip[s]?\s+verif)/i.test(
          text,
        ) ||
        /\bverify(?:ing)?\s+(?:the\s+)?(?:hmac|signature)\b[^.\n]*\b(?:agent|in (?:your|the) agent|yourself)\b/i.test(
          text,
        ),
      evidence: text
        .match(
          /\b(?:raw|tunnel)\b[^.]*?(?:verif|drops? headers|skip)[^.]*|\bverify\b[^.\n]*\bagent\b[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "does-not-claim-webhook-secret-for-bitbucket",
      description:
        "Does NOT tell the user to set WEBHOOK_SECRET for bitbucket — that's the github-only HMAC var",
      // Fail when the answer recommends WEBHOOK_SECRET as the bitbucket
      // secret. Tolerate mentioning WEBHOOK_SECRET in the negative ("don't
      // use WEBHOOK_SECRET, that's for github").
      pass: (() => {
        const matches = [...text.matchAll(/[^.\n]{0,80}WEBHOOK_SECRET[^.\n]{0,80}/g)];
        if (matches.length === 0) return true;
        // Fail only when the answer actively pushes WEBHOOK_SECRET as the
        // bitbucket HMAC variable. Any other mention (explaining it's
        // github-only, telling the user not to use it for bitbucket) is fine.
        const recommendsForBb =
          /\b(?:set|use|configure|put|paste)\s+(?:the\s+)?WEBHOOK_SECRET\b[^.\n]{0,80}\b(?:bitbucket|for\s+(?:your\s+)?bitbucket)\b/i;
        return !recommendsForBb.test(text);
      })(),
      evidence: text.match(/[^.\n]{0,80}WEBHOOK_SECRET[^.\n]{0,80}/)?.[0]?.slice(0, 200),
    },
    {
      id: "recommends-custom-env-var-name",
      description:
        "Recommends a DIFFERENT (non-colliding) env var name for the bitbucket HMAC secret in the agent",
      // The skill suggests something like MY_WORKSPACE_BB_SECRET — anything
      // that isn't WEBHOOK_SECRET and isn't a provider-prefixed lookalike.
      // Pass if the answer either (a) shows a code snippet reading a custom
      // env var via os.environ / process.env, or (b) explicitly says to pick
      // a different var name from WEBHOOK_SECRET.
      pass:
        /os\.environ\[['"][A-Z][A-Z0-9_]*['"]\]/.test(text) ||
        /process\.env\.[A-Z][A-Z0-9_]+/.test(text) ||
        /\b(?:different|distinct|separate|your own|custom|new)\b[^.\n]{0,60}\b(?:env(?:ironment)?\s+(?:var|variable)|name)\b/i.test(
          text,
        ) ||
        /\bdoes(?:n'?t| not)\s+collide\b/i.test(text),
      evidence: text
        .match(
          /os\.environ\[['"][A-Z][A-Z0-9_]*['"]\]|process\.env\.[A-Z][A-Z0-9_]+|\b(?:different|distinct|separate|custom|new)\b[^.\n]{0,80}\b(?:env|var|name)\b[^.\n]{0,40}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "no-deprecated-hook-bitbucket-url",
      description: "Does NOT recommend /hook/bitbucket/ as a way to get signature verification",
      pass: (() => {
        const matches = [...text.matchAll(/(.{0,80}\/hook\/bitbucket\/[^\s)`]*.{0,80})/g)];
        if (matches.length === 0) return true;
        const negativeMarker =
          /\b(?:removed|deprecat|do not|don'?t use|no longer|wrong|incorrect|instead of|NOT use|legacy|previously|was)\b/i;
        return matches.every((m) => negativeMarker.test(m[1] ?? m[0]));
      })(),
      evidence: text.match(/.{0,40}\/hook\/bitbucket\/[^\s)`]*.{0,40}/)?.[0]?.slice(0, 200),
    },
    {
      id: "reads-payload-from-ctx",
      description:
        "References reading the raw body for HMAC computation via ctx.input.config / ctx.input.raw",
      pass: /\bctx\.input\.(?:config|raw)\b/.test(text) || /\b(?:raw|request)\s+body\b/i.test(text),
      evidence: text
        .match(/\bctx\.input\.(?:config|raw)\b|\b(?:raw|request)\s+body\b[^.\n]{0,60}/i)?.[0]
        ?.slice(0, 160),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "bitbucket-hmac-in-agent", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "bitbucket-hmac-in-agent", pass: false, notes, metrics };
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
    { id: "test-webhook-no-bypass", fn: () => runTestWebhookNegativeCheck() },
    { id: "recommends-nowait-pattern", fn: () => runNowaitRecommendation() },
    { id: "recommends-sync-for-output", fn: () => runRecommendsSyncForOutput() },
    { id: "recommends-sse-for-progress", fn: () => runRecommendsSseForProgress() },
    { id: "lists-current-providers", fn: () => runProviderList() },
    { id: "bitbucket-hmac-in-agent", fn: () => runBitbucketHmacInAgent() },
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
