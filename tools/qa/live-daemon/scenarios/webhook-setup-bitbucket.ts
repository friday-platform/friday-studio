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
 *     Must pass every contract check.
 *   - WITHOUT-SKILL (negative / control): just the bare workspace-chat
 *     prompt.txt. Must FAIL at least one of the "knows the URL pattern
 *     and env var" checks — proves the model doesn't already have this
 *     domain knowledge from training and that the skill is the carrier.
 *
 * The full scenario list is wired in `main()` near the bottom of this
 * file — keep that list as the source of truth for count.
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

// Bitbucket Cloud webhook event keys (x-event-key values). Shared by the
// no-fake-event-name check's pass/evidence closures — must be a single
// source of truth so the two copies can't drift.
// Source: https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/
// NOTE: there is no `pullrequest:push` event. A push to a PR source branch
// fires `repo:push` and (separately) `pullrequest:updated`.
const ALLOWED_BITBUCKET_EVENTS = new Set([
  // pullrequest:
  "pullrequest:created",
  "pullrequest:updated",
  "pullrequest:approved",
  "pullrequest:unapproved",
  "pullrequest:changes_request_created",
  "pullrequest:changes_request_removed",
  "pullrequest:fulfilled",
  "pullrequest:rejected",
  "pullrequest:comment_created",
  "pullrequest:comment_updated",
  "pullrequest:comment_deleted",
  "pullrequest:comment_resolved",
  "pullrequest:comment_reopened",
  // repo:
  "repo:push",
  "repo:fork",
  "repo:updated",
  "repo:transfer",
  "repo:created",
  "repo:deleted",
  "repo:imported",
  "repo:commit_comment_created",
  "repo:commit_status_created",
  "repo:commit_status_updated",
  // issue:
  "issue:created",
  "issue:updated",
  "issue:comment_created",
]);
const BITBUCKET_EVENT_REGEX = /\b(?:pullrequest|repo|issue):[a-z_]+(?::[a-z_]+)*\b/gi;

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
  "I set BITBUCKET_WEBHOOK_SECRET in my workspace's env vars expecting Friday to verify the HMAC against the secret I configured in Bitbucket. But my webhook just gets accepted regardless of what signature Bitbucket sends. What am I doing wrong?";

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
// Agent should recommend the in-handler SSE path — Accept: text/event-stream
// on the trigger POST. There is no GET-follow-by-correlationId endpoint:
// the cascade response is published to a core-NATS subject without replay,
// so any path that publishes first and tries to attach a follower later
// races against fast cascades and silently misses the response. Agent must
// NOT recommend polling, must NOT recommend the sync JSON mode and then
// "parse the output for progress" (output is only available at completion),
// and must NOT recommend a /signals/stream/{correlationId} GET-follow.
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

// Scenario 12: regression — user asks for the webhook URL right after the
// workspace is built. Observed live-QA failure mode (2026-05-15): when
// run_code can't reach https://localhost:9090/status from its sandbox,
// the model synthesized "https://<your-friday-host>/api/workspaces/<wsId>/signals/<signalId>"
// — the atlasd-direct path, exactly the Marc-class foot-gun. The skill
// teaches /hook/raw/ on the cloudflared tunnel host; if /status is
// unreachable, the right move is to ASK the user to run the /status
// curl themselves, NOT to synthesize a host or fall back to /api/
// workspaces/. This scenario asserts the model either gives the
// /hook/raw/ pattern with a placeholder for the tunnel host (and
// instructs the user to fetch it from /status) OR asks the user
// directly for the tunnel URL — and must NEVER emit /api/workspaces/
// or "<friday-host>"/"<daemon-host>" pointing at the daemon.
const USER_QUESTION_WEBHOOK_URL_NO_STATUS =
  "I just published the workspace. What's the exact webhook URL to paste into Bitbucket's webhook form? My run_code calls to https://localhost:9090/status are failing with connection refused — I think the tunnel binds localhost but run_code is in a sandbox without host networking. Just give me the URL so I can copy-paste it.";

// Scenario 13: regression — when authoring a workspace.yml for a raw
// webhook signal, the JSON Schema must declare `additionalProperties: true`
// on every `type: object` (or just use the bare top-level form). Observed
// live-QA failure mode (2026-05-15): chat authored the signal schema with
// nested `actor: { type: object, description: "..." }` (no
// `additionalProperties: true`); the runtime's Zod validator silently
// stripped every nested webhook field; the LLM agent saw
// `inputs.actor = {}` etc. and called failStep with "Empty webhook payload
// received — all config fields are empty objects". Assert the chat
// authoring of webhook signal schemas does the right thing.
const USER_QUESTION_WEBHOOK_SCHEMA =
  "Draft the YAML for a `provider: http` signal in workspace.yml that receives raw Bitbucket pullrequest:comment_created webhooks at path /bb-pr-comment. The agent needs to read actor, comment, pullrequest, and repository fields from the payload. Show me the full signal block exactly as it should appear in workspace.yml.";

// ────────────────────────────────────────────────────────────────────────
// GitHub parallel scenarios
// ────────────────────────────────────────────────────────────────────────
//
// The webhook-tunnel is upstream-agnostic — github is just another
// service POSTing to /hook/raw/. These scenarios mirror their bitbucket
// counterparts and use github vocabulary (issue_comment, pull_request,
// X-Hub-Signature-256, tempestteam/atlas) to catch any github-specific
// drift in the skill's guidance.

const USER_QUESTION_SETUP_GITHUB =
  "I added a `gh-issue-comment` HTTP signal to this workspace. How do I configure GitHub to send issue-comment events to it? Walk me through the URL to paste in GitHub's webhook form, what content-type/secret to set, which events to subscribe to, and how to debug if it doesn't fire.";

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
 * Contract checks on the assistant's response text for the setup-walkthrough
 * scenario — if any of these flip in the WITH-SKILL variant, the skill stopped
 * doing its job and the Bitbucket-class wiring bugs are back. The actual count
 * is whatever this function returns at call time; the runtime printout uses
 * `checks.length`, so don't hard-code numbers here.
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
        // Tolerate log-filtering / debug references — the model often shows
        // the internal path as something to grep for in atlasd logs, which
        // is correct usage, not a webhook-URL recommendation.
        const logOrDebugContext =
          /\b(?:look\s+for|search\s+for|grep\s+for|find|filter\s+(?:by|on)|entries?|log\s+line|in\s+(?:the\s+)?logs?|debug|inspect)\b/i;
        return matches.every((m) => {
          const ctx = m[1] ?? m[0];
          return (
            negativeMarker.test(ctx) || tunnelIntrospection.test(ctx) || logOrDebugContext.test(ctx)
          );
        });
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
    {
      // POSITIVE-KNOWLEDGE: Friday-specific architectural fact. The /hook/raw/
      // path forwards the body verbatim WITHOUT HMAC verification — the workspace
      // agent owns secret validation. A bare model usually says "use a webhook
      // secret" generically (and may suggest the tunnel/receiver verifies), but
      // the assignment of HMAC responsibility to the agent is in the skill body,
      // not in any generic webhook tutorial.
      id: "tunnel-doesnt-verify",
      description:
        "explicitly says the tunnel/raw path does NOT verify the signature — verification lives in the workspace agent",
      pass:
        /\b(?:tunnel|raw|hook\/raw)\b[^.\n]{0,80}(?:no(?:t)?\s+verif|doesn'?t\s+verif|does not verif|skip[s]?\s+verif|drops? (?:the )?(?:secret|signature|headers?)|no hmac|without (?:hmac|verif)|pass(?:es)?(?:-| )?through)/i.test(
          text,
        ) ||
        /\b(?:agent|workspace|your (?:code|agent))\b[^.\n]{0,80}(?:verif|hmac|check (?:the )?signature|validate (?:the )?signature)/i.test(
          text,
        ),
      evidence: text
        .match(
          /\b(?:tunnel|raw|hook\/raw)\b[^.\n]{0,80}(?:no(?:t)?\s+verif|doesn'?t\s+verif|skip[s]?\s+verif|drops? (?:the )?(?:secret|signature|headers?)|no hmac|pass(?:es)?(?:-| )?through)|\b(?:agent|workspace)\b[^.\n]{0,80}(?:verif|hmac|check (?:the )?signature)/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      // POSITIVE-KNOWLEDGE: Friday/Zod-specific schema rule. When the signal
      // schema's top-level object declares `type: object` without
      // `additionalProperties: true`, Zod silently strips every unknown field
      // — so a Bitbucket POST arrives at the workspace agent with the body
      // emptied. The skill teaches that nested webhook signal schemas MUST
      // declare `additionalProperties: true` (or use the bare top-level
      // shape). A bare model writing a generic webhook tutorial does not know
      // this Friday-runtime detail.
      id: "additional-properties-rule",
      description:
        "mentions the `additionalProperties: true` requirement on the signal schema (Friday/Zod-specific Run-dialog/payload-stripping rule)",
      pass: /additional[-_]?properties\s*:\s*true/i.test(text),
      evidence: text.match(/additional[-_]?properties\s*:\s*true/i)?.[0],
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

  // without-skill (control): we expect failures, but specifically in
  // POSITIVE-KNOWLEDGE checks (Friday-tunnel-specific facts a bare model
  // doesn't know). Negative-polarity checks like `no-wrong-env-var` pass
  // trivially for a bare model — it has nothing to invent. Checks that
  // test generic knowledge (Bitbucket event names, "if env var is
  // mentioned it's WEBHOOK_SECRET") also pass trivially and aren't
  // proof of skill load-bearing-ness.
  //
  // To prove the skill is the carrier, require ≥2 truly-Friday-specific
  // checks to fail in the control. The set is intentionally narrow: only
  // facts that ONLY exist in Friday's runtime + this skill's body. Note
  // that `url-pattern` is the weakest of the four — `/hook/raw/{ws}/{sig}`
  // has leaked into public training corpora so a bare model often gets it
  // right by reflex; the other three are the load-bearing signal.
  const POSITIVE_KNOWLEDGE_CHECKS = new Set([
    "url-pattern", //                  /hook/raw/{workspaceId}/{signalId} (often known by bare model)
    "status-endpoint", //              GET /status discovery endpoint (Friday-tunnel-specific)
    "tunnel-doesnt-verify", //         Verification responsibility is on the agent, not the tunnel
    "additional-properties-rule", //   Zod-strip foot-gun: signal schemas need additionalProperties:true
  ]);
  const positiveFailed = failed.filter((c) => POSITIVE_KNOWLEDGE_CHECKS.has(c.id));
  const MIN_POSITIVE_FAILURES = 2;

  if (positiveFailed.length < MIN_POSITIVE_FAILURES) {
    notes.push(
      `Negative-control: ${positiveFailed.length}/${POSITIVE_KNOWLEDGE_CHECKS.size} positive-knowledge checks failed ` +
        `(need ≥${MIN_POSITIVE_FAILURES}). The skill isn't earning its keep — either the model already knows ` +
        `Friday's wiring from training, or the contract is too lenient. Tighten the positive-knowledge checks.`,
    );
    for (const c of checks) {
      notes.push(
        `  ${c.pass ? "✓" : "✗"} ${c.id}${POSITIVE_KNOWLEDGE_CHECKS.has(c.id) ? " [POS]" : ""}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
      );
    }
    return { id: variant, pass: false, notes, metrics };
  }
  notes.push(
    `Negative-control: ${positiveFailed.length}/${POSITIVE_KNOWLEDGE_CHECKS.size} positive-knowledge checks failed ` +
      `(${failed.length}/${checks.length} total) — skill is the load-bearing carrier of this knowledge.`,
  );
  for (const c of checks) {
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}${POSITIVE_KNOWLEDGE_CHECKS.has(c.id) ? " [POS]" : ""}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
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
      id: "explains-tunnel-does-no-hmac",
      description:
        "Explains the tunnel does NOT verify HMAC at all — there is no Friday-level secret env var, so the user's BITBUCKET_WEBHOOK_SECRET isn't being read by anything",
      // Tunnel was simplified — raw is the only provider, and it doesn't
      // verify signatures. The agent should explain that any HMAC has to
      // happen in the agent code itself.
      pass:
        /\b(?:tunnel|raw|friday)\b[^.]*(?:no(?:t)?\s+verif|doesn'?t\s+verif|don'?t\s+verif|never\s+verif|does\s+no\s+(?:HMAC|verification|signature))/i.test(
          result.text,
        ) ||
        /\bno\s+(?:friday[-\s]?level\s+)?(?:HMAC|signature|secret)\s+(?:verif|env(?:ironment)?\s+(?:var|variable))/i.test(
          result.text,
        ) ||
        /\b(?:there\s+is\s+no|isn'?t\s+a)\s+(?:friday[-\s]?level\s+)?(?:secret|env(?:ironment)?\s+var(?:iable)?)\b/i.test(
          result.text,
        ),
      evidence: result.text
        .match(
          /\b(?:tunnel|raw|friday)\b[^.]*?(?:no(?:t)?\s+verif|doesn'?t\s+verif|never\s+verif|does\s+no)\b[^.]{0,60}/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      id: "diagnoses-real-problem",
      description:
        "Explains the user's real issue (the URL/path probably isn't /hook/raw/, or BITBUCKET_WEBHOOK_SECRET is not a Friday env var)",
      // Real issue post-simplification: the tunnel does no HMAC, so any
      // env var the user set for that purpose just sits unread. The agent
      // should explain either (a) the env var isn't a Friday-level secret,
      // (b) the tunnel doesn't verify, or (c) "does nothing" / "no-op".
      pass:
        /\bnot (?:a |an )?(?:friday|valid|recognized|real|known) env(?:ironment)? var/i.test(
          result.text,
        ) ||
        /\bisn'?t (?:read|recognized|used) by\b/i.test(result.text) ||
        /\bdoesn'?t exist\b/i.test(result.text) ||
        /\bsilently (?:ignor|not read)/i.test(result.text) ||
        /\/hook\/raw\//.test(result.text) ||
        /\b(?:does(?:n'?t| not)\s+(?:do anything|nothing|verify|read)|sits?\s+unread|isn'?t\s+being\s+read|no\s+(?:effect|HMAC)|no[-\s]?op|nothing\s+reads?\s+(?:that|it))\b/i.test(
          result.text,
        ) ||
        /\b(?:tunnel|friday)\b[^.\n]{0,80}\b(?:doesn'?t|does\s+not|never|no longer)\s+(?:verif|check|HMAC|read)/i.test(
          result.text,
        ),
      evidence: result.text
        .match(
          /(?:not (?:a |an )?(?:friday|valid|recognized|real|known) env|isn'?t (?:read|recognized|used)|doesn'?t exist|silently ignor|does(?:n'?t| not)\s+(?:do anything|nothing|verify))[^\n]{0,80}|\/hook\/raw\/[^\s)`]+/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      id: "no-friday-level-secret-claim",
      description:
        "Does NOT claim a provider-prefixed env var (BITBUCKET_WEBHOOK_SECRET etc.) is a Friday-level reserved name the tunnel/atlasd reads",
      // Post-simplification: there is no Friday-level webhook secret var.
      // The user can name an env var anything — including BITBUCKET_WEBHOOK_SECRET —
      // and read it in the agent. Failure mode the check guards against:
      // the agent claims a provider-prefixed name has special status (e.g.
      // "Friday looks for BITBUCKET_WEBHOOK_SECRET" / "atlasd reads JIRA_HOOK_SECRET").
      pass: !/\b(?:friday|atlasd|tunnel|webhook[-\s]?tunnel)\b[^.\n]{0,80}\b(?:reads?|looks?\s+(?:for|up)|recognizes?|honors?|checks?\s+(?:for|the))\b[^.\n]{0,60}\b(?:JIRA|GITHUB|BITBUCKET)_(?:WEBHOOK|HOOK)_(?:SECRET|TOKEN|KEY)\b/i.test(
        result.text,
      ),
      evidence: result.text
        .match(
          /\b(?:friday|atlasd|tunnel|webhook[-\s]?tunnel)\b[^.\n]{0,80}\b(?:reads?|looks?|recognizes?|honors?|checks?)\b[^.\n]{0,80}\b(?:JIRA|GITHUB|BITBUCKET)_[A-Z_]+\b/i,
        )?.[0]
        ?.slice(0, 200),
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
        "does NOT invent Bitbucket event names that don't exist (allowlist of real `pullrequest:` / `repo:` / `issue:` events; anything else is hallucinated)",
      pass: (() => {
        const matches = result.text.match(BITBUCKET_EVENT_REGEX);
        if (!matches) return true;
        return matches.every((m) => ALLOWED_BITBUCKET_EVENTS.has(m.toLowerCase()));
      })(),
      evidence: (() => {
        const matches = result.text.match(BITBUCKET_EVENT_REGEX);
        const bad = matches?.filter((m) => !ALLOWED_BITBUCKET_EVENTS.has(m.toLowerCase()));
        return bad && bad.length > 0 ? bad.slice(0, 5).join(", ") : undefined;
      })(),
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
        // And evidence the response will contain the cascade fields.
        // Accept any of: prose ("response has output"), member access
        // (`result.output`), bracket access (`result["output"]`), inline
        // code comments listing keys (`# result has: { "output": ... }`),
        // or just naming 2+ of the four canonical fields near "result"/
        // "response"/"json".
        const explainsShape =
          /\b(?:output|summary|sessionId|artifactIds|result)\b[^.\n]{0,80}\b(?:back|in (?:the )?response|return[s]?|response includes|response has|response contains|has )/i.test(
            plain,
          ) ||
          /\b(?:response|envelope|json|payload|result)\b[^.\n]{0,120}\b(?:has|includes|contains|with|holding|carrying|like|:)\b[^.\n]{0,120}\b(?:output|summary|sessionId|artifactIds)/i.test(
            plain,
          ) ||
          /\bresult(?:\.(?:output|summary|sessionId|artifactIds)|\[\s*['"](?:output|summary|sessionId|artifactIds)['"]\s*\])/i.test(
            plain,
          ) ||
          // 2+ of the canonical field names present within a short window
          // — strong signal the model laid out the envelope shape.
          (() => {
            const fields = ["output", "summary", "sessionId", "artifactIds"];
            const hits = fields.filter((f) => new RegExp(`\\b${f}\\b`).test(plain));
            return hits.length >= 2;
          })();
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
    // Positive — SSE on the trigger POST is the right answer
    {
      id: "recommends-sse-or-event-stream",
      description: "Recommends SSE — Accept: text/event-stream on the trigger POST",
      pass:
        /\btext\/event-stream\b/i.test(result.text) ||
        /\bSSE\b/.test(result.text) ||
        /\bserver[-\s]?sent\s+events\b/i.test(result.text),
      evidence: result.text.match(
        /\btext\/event-stream\b|\bSSE\b|\bserver[-\s]?sent\s+events\b/i,
      )?.[0],
    },
    // Negative — the broken follow-by-correlationId endpoint must NOT be recommended
    {
      id: "no-sse-follow-by-correlation",
      description:
        "Does NOT recommend a GET /signals/stream/{correlationId} follow — that endpoint was removed because subscribing AFTER publish races the response on core NATS",
      pass: !/\/signals\/stream\/(?:\{?correlationId\}?|<correlationId>|[a-z0-9-]+)/i.test(
        result.text,
      ),
      evidence: result.text.match(/[^\s]*\/signals\/stream\/[^\s)`]+/i)?.[0]?.slice(0, 160),
    },
    {
      id: "explains-streaming-mechanism",
      description:
        "Explains the streaming mechanism (chunks/data:/events arriving as the cascade runs)",
      // \bdata:\b is buggy — `:` is non-word, so the trailing \b fails to
      // anchor. Use \bdata\s*: instead, and broaden the SSE-event detection
      // to recognize concrete event names the model lists (cascade.*, etc.).
      pass:
        /\bchunk[s]?\b/i.test(result.text) ||
        /\bdata\s*:\s*[<`{[]/i.test(result.text) ||
        /\bevent\s*:\s*[a-z]/i.test(result.text) ||
        /\b(?:cascade|agent|tool|session)\.(?:started|completed|block|error|chunk|done)\b/i.test(
          result.text,
        ) ||
        /\bevent[s]?\b[^.\n]{0,40}\b(?:as|arriv|stream|happen|fire|emit)/i.test(result.text) ||
        /\bstream(?:s|ing|ed)?\b[^.\n]{0,80}\b(?:as|while|during|in real[\s-]?time|live)\b/i.test(
          result.text,
        ),
      evidence: result.text
        .match(
          /\b(?:chunk[s]?|data\s*:|event\s*:|stream(?:s|ing)?|(?:cascade|agent|tool|session)\.(?:started|completed|block|error|chunk|done))\b[^.\n]{0,80}/i,
        )?.[0]
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
      id: "names-raw-only",
      description:
        "Names `raw` as the single built-in provider — github/bitbucket/jira are NOT built-in",
      // Must mention `raw` AND must not pair another provider word with
      // `raw` in a provider-listing context. Catches phrasings like "we
      // support `raw` and `bitbucket`" or "providers: raw, github".
      pass:
        /\braw\b/i.test(text) &&
        !/(?:^|[^a-z])(?:two|both|2)\s+(?:built[-\s]?in\s+)?providers\b/i.test(text) &&
        !/\braw\b[^.\n]{0,40}(?:\s+(?:and|,|\+|\|)\s+|\s+plus\s+)`?(?:github|bitbucket|jira)`?\b/i.test(
          text,
        ) &&
        !/`?(?:github|bitbucket|jira)`?[^.\n]{0,40}(?:\s+(?:and|,|\+|\|)\s+|\s+plus\s+)`?raw`?\b/i.test(
          text,
        ),
      evidence: text
        .match(/\braw\b[^\n.]{0,80}|providers?\s*[:=]\s*[^\n]{0,80}/i)?.[0]
        ?.slice(0, 160),
    },
    {
      id: "does-not-list-bitbucket-as-builtin",
      description: "Does NOT present `bitbucket` as a built-in provider — only `raw` ships",
      // Fail only when bitbucket appears as a code-formatted provider
      // name (backticks/quotes) in a "providers:" listing — e.g.
      // `providers: [\`raw\`, \`bitbucket\`]` or `"providers": ["raw","bitbucket"]`.
      // Capitalized "Bitbucket" in parenthetical SaaS-product lists doesn't count.
      pass: (() => {
        const codeFormattedBitbucket = /["'`]bitbucket["'`]/g;
        const matches = [...text.matchAll(codeFormattedBitbucket)];
        if (matches.length === 0) return true;
        // For each backticked/quoted `bitbucket` mention, check that the
        // surrounding 80-char window does NOT pair it with "providers:" /
        // an array of providers WITHOUT a negative marker.
        const negativeMarker =
          /\b(?:removed|deprecat|do not|don'?t|no longer|wrong|incorrect|NOT|legacy|previously|was|goes through|use\s+(?:the\s+)?raw|via\s+(?:the\s+)?raw|through\s+(?:the\s+)?raw|\/hook\/raw\/|isn'?t|aren'?t|dedicated\s+bitbucket\b|unknown\s+provider)\b/i;
        for (const m of matches) {
          const start = Math.max(0, (m.index ?? 0) - 80);
          const end = Math.min(text.length, (m.index ?? 0) + 80);
          const ctx = text.slice(start, end);
          const isProviderList =
            /providers?\s*(?:are|:|include[s]?|list|registered)|"providers"\s*:|\[[^\]]*["'`]raw["'`][^\]]*["'`]bitbucket/i.test(
              ctx,
            );
          if (isProviderList && !negativeMarker.test(ctx)) return false;
        }
        return true;
      })(),
      evidence: text.match(/[^.\n]{0,80}["'`]bitbucket["'`][^.\n]{0,80}/i)?.[0]?.slice(0, 200),
    },
    {
      id: "does-not-list-jira-as-builtin",
      description: "Does NOT present `jira` as a built-in provider",
      pass: (() => {
        const codeFormattedJira = /["'`]jira["'`]/gi;
        const matches = [...text.matchAll(codeFormattedJira)];
        if (matches.length === 0) return true;
        const negativeMarker =
          /\b(?:removed|deprecat|do not|don'?t|no longer|wrong|incorrect|NOT|legacy|previously|was|goes through|use\s+(?:the\s+)?raw|via\s+(?:the\s+)?raw|through\s+(?:the\s+)?raw|\/hook\/raw\/|isn'?t|aren'?t|dedicated\s+jira\b|unknown\s+provider)\b/i;
        for (const m of matches) {
          const start = Math.max(0, (m.index ?? 0) - 80);
          const end = Math.min(text.length, (m.index ?? 0) + 80);
          const ctx = text.slice(start, end);
          const isProviderList =
            /providers?\s*(?:are|:|include[s]?|list|registered)|"providers"\s*:|\[[^\]]*["'`]raw["'`][^\]]*["'`]jira/i.test(
              ctx,
            );
          if (isProviderList && !negativeMarker.test(ctx)) return false;
        }
        return true;
      })(),
      evidence: text.match(/[^.\n]{0,80}["'`]jira["'`][^.\n]{0,80}/i)?.[0]?.slice(0, 200),
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
      id: "does-not-list-github-as-builtin",
      description:
        "Does NOT present `github` as a built-in provider with HMAC/event-filter (github support was dropped — github webhooks now use /hook/raw/ like everything else)",
      pass: (() => {
        // Only flag backtick/quote-formatted `github` (matches the bitbucket/jira
        // pattern). Capitalized "GitHub" in parenthetical SaaS-product lists or
        // in path examples that get 400'd doesn't count.
        const codeFormattedGithub = /["'`]github["'`]/gi;
        const matches = [...text.matchAll(codeFormattedGithub)];
        if (matches.length === 0) return true;
        const negativeMarker =
          /\b(?:removed|deprecat|do not|don'?t|no longer|wrong|incorrect|NOT|legacy|previously|was|goes through|use\s+(?:the\s+)?raw|via\s+(?:the\s+)?raw|through\s+(?:the\s+)?raw|\/hook\/raw\/|isn'?t|aren'?t|dropped|simplified|unknown\s+provider|will\s+(?:return|fail|404|400)|any\s+other\s+provider|e\.?g\.?\b)\b/i;
        for (const m of matches) {
          const start = Math.max(0, (m.index ?? 0) - 80);
          const end = Math.min(text.length, (m.index ?? 0) + 80);
          const ctx = text.slice(start, end);
          const isProviderList =
            /providers?\s*(?:are|:|include[s]?|list|registered)|"providers"\s*:|\[[^\]]*["'`]raw["'`][^\]]*["'`]github/i.test(
              ctx,
            );
          if (isProviderList && !negativeMarker.test(ctx)) return false;
        }
        return true;
      })(),
      evidence: text.match(/[^.\n]{0,80}["'`]github["'`][^.\n]{0,80}/i)?.[0]?.slice(0, 200),
    },
    {
      id: "no-webhook-mappings-recommendation",
      description:
        "Does NOT recommend WEBHOOK_MAPPINGS_PATH (it no longer exists; tunnel was simplified to raw-only)",
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
// ───── Scenario 12: no atlasd-URL fallback when /status is unreachable ───

async function runNoAtlasdUrlFallback(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (no-atlasd-url-fallback)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_WEBHOOK_URL_NO_STATUS);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "no-atlasd-direct-path-recommendation",
      description:
        "Does NOT emit /api/workspaces/<wsId>/signals/<signalId> as the webhook URL — that's atlasd's internal path, not the public tunnel",
      // The exact failure observed in live QA. Tolerate the path appearing
      // only inside a "do NOT use this" explanation; fail if it's emitted
      // as a recommended URL.
      pass: (() => {
        const matches = [
          ...text.matchAll(/(.{0,80}\/api\/workspaces\/[^/\s]+\/signals\/[^\s)`]+.{0,80})/g),
        ];
        if (matches.length === 0) return true;
        const negativeMarker =
          /\b(?:do not|don'?t use|wrong|incorrect|atlasd|internal|NOT (?:use|reach)|404|not reachable|don'?t (?:point|hit)|never|do NOT)\b/i;
        return matches.every((m) => negativeMarker.test(m[1] ?? m[0]));
      })(),
      evidence: text.match(/[^\s]*\/api\/workspaces\/[^/\s]+\/signals\/[^\s)`]*/)?.[0],
    },
    {
      id: "no-synthesized-friday-host",
      description:
        "Does NOT pair a synthesized host placeholder like <your-friday-host>/<friday-daemon>/<daemon-host> with /api/workspaces/ or any signal-trigger path",
      pass: !/<(?:your-)?(?:friday|daemon|atlas)[a-z-]*(?:-host|-url|-public-host)?>[\s\S]{0,80}(?:\/api\/workspaces\/|\/signals\/)/i.test(
        text,
      ),
      evidence: text
        .match(
          /<(?:your-)?(?:friday|daemon|atlas)[a-z-]*(?:-host|-url|-public-host)?>[^\n]{0,120}/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      id: "recommends-hook-raw-or-asks-for-tunnel-url",
      description:
        "Either emits the /hook/raw/ pattern (with a tunnel-host placeholder) OR explicitly asks the user to fetch the tunnel URL themselves",
      pass:
        /\/hook\/raw\/[^\s)`]+/i.test(text) ||
        /\b(?:please\s+)?(?:run|paste|share|provide|tell me|give me|copy)\b[^.\n]{0,80}(?:\/status|tunnel\s+URL|tunnel-url|public\s+(?:tunnel\s+)?(?:URL|hostname))/i.test(
          text,
        ) ||
        /\bcurl\b[^.\n]{0,60}localhost:9090\/status/i.test(text),
      evidence: text
        .match(
          /\/hook\/raw\/[^\s)`]+|\b(?:run|paste|share|provide|tell me|give me|copy)[^.\n]{0,80}(?:\/status|tunnel\s+URL|public\s+(?:tunnel\s+)?(?:URL|hostname))[^.\n]{0,40}|\bcurl\b[^.\n]{0,60}\/status/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "mentions-trycloudflare-or-public-tunnel",
      description:
        "Names the cloudflared tunnel / trycloudflare / public tunnel URL as the host source — not localhost, not a daemon port",
      pass:
        /\btrycloudflare\b/i.test(text) ||
        /\b(?:cloudflared|public\s+tunnel|tunnel\s+host|tunnel\s+URL)\b/i.test(text),
      evidence: text.match(
        /\btrycloudflare\b|\b(?:cloudflared|public\s+tunnel|tunnel\s+host|tunnel\s+URL)\b/i,
      )?.[0],
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "no-atlasd-url-fallback", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "no-atlasd-url-fallback", pass: false, notes, metrics };
}

// ───── Scenario 13: webhook signal schema must let the body through ─────

async function runWebhookSignalSchema(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (webhook-signal-schema-passes-body)");
  const system = await buildSystem("with-skill");
  const result = await drive(system, USER_QUESTION_WEBHOOK_SCHEMA);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "declares-additional-properties-true",
      description:
        "Declares `additionalProperties: true` somewhere in the signal schema — without it Zod strips nested webhook fields",
      pass: /\badditionalProperties\s*:\s*true\b/i.test(text),
      evidence: text
        .match(/[^\n]{0,40}additionalProperties\s*:\s*true[^\n]{0,40}/i)?.[0]
        ?.slice(0, 160),
    },
    {
      id: "no-strict-nested-object-properties",
      description:
        "Does NOT declare `actor:`/`comment:`/`pullrequest:`/`repository:` as `type: object` without `additionalProperties: true`",
      // Fail if any of the four named nested fields appears with `type:
      // object` but no `additionalProperties: true` within ~120 chars of
      // the same block.
      pass: (() => {
        const violators = ["actor", "comment", "pullrequest", "repository"];
        for (const name of violators) {
          // Match a YAML-style block: `<name>: { type: object, ... }` OR
          //                          `<name>:\n  type: object\n  ...`
          // and check that within ~200 chars there's no additionalProperties: true.
          const re = new RegExp(
            `\\b${name}\\s*:[\\s\\S]{0,30}type\\s*:\\s*object([\\s\\S]{0,200})`,
            "gi",
          );
          for (const m of text.matchAll(re)) {
            const tail = m[1] ?? "";
            // If tail before the next top-level key doesn't contain
            // additionalProperties: true, it's a violator.
            if (!/additionalProperties\s*:\s*true/i.test(tail)) return false;
          }
        }
        return true;
      })(),
      evidence: (() => {
        const violators = ["actor", "comment", "pullrequest", "repository"];
        for (const name of violators) {
          const m = text.match(
            new RegExp(`\\b${name}\\s*:[^\\n]{0,80}type\\s*:\\s*object[^\\n]{0,80}`, "i"),
          );
          if (m) return m[0].slice(0, 160);
        }
        return undefined;
      })(),
    },
    {
      id: "warns-about-strip-or-recommends-bare-schema",
      description:
        "Either warns explicitly that Zod/the runtime strips undeclared fields, or recommends the bare `{ type: object, additionalProperties: true }` shape",
      pass:
        /\bstrip(?:s|ped|ping)?\b/i.test(text) ||
        /\b(?:Zod|validator|schema)\b[^.\n]{0,60}\b(?:strip|drop|remove)/i.test(text) ||
        /type\s*:\s*object[\s\S]{0,40}additionalProperties\s*:\s*true(?![\s\S]{0,60}properties\s*:)/i.test(
          text,
        ),
      evidence: text
        .match(
          /\b(?:strip|Zod|validator)\b[^.\n]{0,140}|type\s*:\s*object[\s\S]{0,40}additionalProperties\s*:\s*true/i,
        )?.[0]
        ?.slice(0, 180),
    },
    {
      id: "names-provider-http",
      description: "Names `provider: http` (the right provider key for HTTP-trigger signals)",
      pass: /\bprovider\s*:\s*http\b/i.test(text),
      evidence: text.match(/provider\s*:\s*http/i)?.[0],
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "webhook-signal-schema-passes-body", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "webhook-signal-schema-passes-body", pass: false, notes, metrics };
}

// ───── GitHub parallel scenarios ─────────────────────────────────────────

// Synthetic github workspace for setup walkthrough.
const WORKSPACE_SECTION_GITHUB = `<workspace>
<workspace_id>quiet_jasmine</workspace_id>
<workspace_name>Atlas GitHub Issue Bot</workspace_name>
<signals>
<signal id="gh-issue-comment" provider="http" path="/gh-issue-comment">GitHub webhook — issue_comment events on tempestteam/atlas.</signal>
</signals>
<jobs>
<job name="ack-issue-comment" triggers="gh-issue-comment">Receives the GitHub webhook payload and posts a threaded ACK.</job>
</jobs>
</workspace>`;

async function buildSystemGithub(): Promise<string> {
  const prompt = await Deno.readTextFile(PROMPT_PATH);
  const skill = await Deno.readTextFile(SKILL_PATH);
  return [
    prompt,
    WORKSPACE_SECTION_GITHUB,
    SKILL_INDEX_WITH_WIRING,
    `<loaded_skill name="@friday/wiring-external-webhooks">\n${skill}\n</loaded_skill>`,
  ].join("\n\n");
}

async function runGithubSetup(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (github-setup-walkthrough)");
  const system = await buildSystemGithub();
  const result = await drive(system, USER_QUESTION_SETUP_GITHUB);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;
  const has = (n: string) => text.toLowerCase().includes(n.toLowerCase());

  const checks: ContractCheck[] = [
    {
      id: "url-pattern-hook-raw",
      description: "mentions /hook/raw/{workspaceId}/{signalId} pattern",
      pass: /\/hook\/raw\//.test(text),
      evidence: text.match(/\/hook\/raw\/[^\s)`]+/i)?.[0],
    },
    {
      id: "content-type-json",
      description:
        "tells the user to set Content type to application/json (GitHub's default is x-www-form-urlencoded)",
      pass:
        /\bapplication\/json\b/i.test(text) ||
        /\bcontent[-\s]?type\b[^.\n]{0,60}\bjson\b/i.test(text),
      evidence: text.match(/\bcontent[-\s]?type\b[^.\n]{0,80}/i)?.[0]?.slice(0, 120),
    },
    {
      id: "event-list-github",
      description: "names at least one GitHub event (issue_comment / pull_request / push / etc.)",
      pass:
        has("issue_comment") ||
        has("issue comment") ||
        has("pull_request") ||
        has("pull request") ||
        /\b(?:push|release|workflow_run|issues|comment)\b[^.\n]{0,60}\b(?:event|trigger|webhook|subscrib)/i.test(
          text,
        ),
      evidence: text
        .match(
          /\b(?:issue_comment|issue\s+comment|pull_request|pull\s+request|push|release|workflow_run|issues)\b[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 160),
    },
    {
      id: "status-endpoint",
      description: "points at GET /status for debugging",
      pass: /\/status\b/.test(text),
      evidence: text.match(/[^\s]*\/status[^\s]*/)?.[0],
    },
    {
      id: "no-atlasd-direct-path-as-webhook-url",
      description:
        "does NOT recommend /api/workspaces/.../signals/<id> as the webhook URL (atlasd internal path)",
      pass: (() => {
        const matches = [
          ...text.matchAll(/(.{0,80}\/api\/workspaces\/[^/\s]+\/signals\/[^\s)`]*.{0,80})/g),
        ];
        if (matches.length === 0) return true;
        const neg =
          /\b(?:do not|don'?t use|wrong|incorrect|atlasd'?s|internal|NOT (?:use|reach)|404|not reachable|don'?t (?:point|hit))\b/i;
        const introspection = /\/(?:history|status)(?:\?|$|\s|\))/;
        const logCtx =
          /\b(?:look\s+for|search\s+for|grep\s+for|find|filter\s+(?:by|on)|entries?|log\s+line|in\s+(?:the\s+)?logs?|debug|inspect)\b/i;
        return matches.every((m) => {
          const ctx = m[1] ?? m[0];
          return neg.test(ctx) || introspection.test(ctx) || logCtx.test(ctx);
        });
      })(),
      evidence: text.match(/[^\s]*\/api\/workspaces\/[^/\s]+\/signals\/[^\s)`]*/)?.[0],
    },
    {
      id: "no-handrolled-tunnel-setup",
      description: "does NOT tell user to install/run cloudflared / ngrok / their own tunnel",
      pass: !/\b(?:install|brew install|download|set up|setup|run|spawn|start)\b[^.\n]{0,60}\b(?:cloudflared|ngrok|tailscale funnel|localtunnel|serveo)\b/i.test(
        text,
      ),
      evidence: text.match(
        /\b(?:install|brew install|download|set up|setup|run|spawn|start)\b[^.\n]{0,60}\b(?:cloudflared|ngrok|tailscale funnel|localtunnel|serveo)\b/i,
      )?.[0],
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "github-setup-walkthrough", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "github-setup-walkthrough", pass: false, notes, metrics };
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
    { id: "points-at-status-first", fn: () => runPointsAtStatusFirst() },
    { id: "test-webhook-no-bypass", fn: () => runTestWebhookNegativeCheck() },
    { id: "recommends-nowait-pattern", fn: () => runNowaitRecommendation() },
    { id: "recommends-sync-for-output", fn: () => runRecommendsSyncForOutput() },
    { id: "recommends-sse-for-progress", fn: () => runRecommendsSseForProgress() },
    { id: "lists-current-providers", fn: () => runProviderList() },
    { id: "no-atlasd-url-fallback", fn: () => runNoAtlasdUrlFallback() },
    { id: "webhook-signal-schema-passes-body", fn: () => runWebhookSignalSchema() },
    { id: "github-setup-walkthrough", fn: () => runGithubSetup() },
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
