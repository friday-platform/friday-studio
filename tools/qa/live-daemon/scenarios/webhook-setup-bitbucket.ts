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
 * The full scenario list (11 total) is wired in `main()` near the bottom
 * of this file — keep that list as the source of truth for count.
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
  "I set BITBUCKET_WEBHOOK_SECRET in my workspace's env vars expecting Friday to verify the HMAC against the secret I configured in Bitbucket. But my webhook just gets accepted regardless of what signature Bitbucket sends. What am I doing wrong?";

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

const USER_QUESTION_LOOP_TRAP_GITHUB =
  "I built an agent that auto-replies to GitHub issue comments. It worked for the first comment but now it's posting to its own replies in a loop — there are 18 replies on the issue already. What did I do wrong and how do I fix it?";

const USER_QUESTION_GITHUB_HMAC =
  "I want HMAC signature verification on my GitHub webhook to my Friday workspace — I don't want random people POSTing to the public tunnel URL. GitHub sends `X-Hub-Signature-256`. How do I set up verification?";

// Scenario: chat asked to author an agent that uses gh CLI to reply.
// The skill teaches: if the prompt invokes bash/gh/curl/MCP-tool, the
// agent's tools array MUST include the matching tool. Otherwise the
// LLM has no callable tool and fakes success via `complete`. Caught
// live during QA — chat authored `tools: []` with a prompt that said
// "Run: gh api ...", session completed in 1.2s with phantom-ACK.
const USER_QUESTION_AGENT_TOOLS_REQUIRED =
  "Draft the YAML for an `llm` agent named `ack-commenter` in workspace.yml. Its job: read a GitHub `issue_comment` webhook payload, then post an 'ACK' reply on the same issue using the `gh` CLI (e.g. `gh api repos/<owner>/<repo>/issues/<N>/comments -X POST -f body='ACK'`). Show me the complete agent block exactly as it should appear in workspace.yml — provider, model, prompt, tools, all of it.";

// Live QA observed: chat authored an LLM agent with the natural prompt
// "skip if body starts with 'ACK'". The LLM ignored the guard at
// runtime — 3 ACK→ACK→ACK comments before the webhook was killed
// manually. The skill now teaches: use a unique marker (e.g.
// `[fri-bot-v1]`) embedded in the bot reply that the guard checks
// for, OR move to a deterministic Python guard.
const USER_QUESTION_LOOP_GUARD_RELIABILITY =
  "Help me wire an auto-ACK bot for GitHub issue comments on tempestteam/atlas. Loop containment is CRITICAL — last time we got 18 spam comments before catching the loop. Draft the agent's prompt section (the `prompt:` field) showing exactly how the loop guard should work. The agent is `type: llm` with `tools: [bash]` and uses `gh api ... comments -X POST` to post the reply.";

// Live QA observed: chat authored an agent that called the github
// MCP tool `add_issue_comment` with LLM-generated args. The LLM
// hallucinated `issue_number: 1` despite the webhook payload (and
// the template substitution) supplying `issue_number: 3091`. The
// skill now teaches: route dynamic identifiers through the command
// STRING (bash + gh CLI), not through MCP tool args (which the LLM
// picks).
const USER_QUESTION_REPLY_VIA_BASH_NOT_MCP =
  "I'm building an LLM agent that auto-replies to a GitHub issue_comment webhook on tempestteam/atlas. The agent needs to read the webhook's issue_number from the payload and post an ACK reply on that same issue. Should I (a) call the github MCP tool `add_issue_comment` with the issue_number as a tool arg, or (b) shell out to `gh api repos/.../issues/<N>/comments -X POST -f body=...` via bash? What's the right pattern for the dynamic-identifier flow?";

// Live QA observed: chat-authored Python agent did
// `payload['issue']['number']` unconditionally and crashed with
// KeyError when github sent its automatic `ping` event at hook
// creation (payload has hook/sender/zen but no issue). The skill
// now teaches: guard for missing fields before extracting.
const USER_QUESTION_PING_EVENT_TOLERANCE =
  "Draft a Python `user` agent for a webhook signal that handles GitHub `issue_comment` events on tempestteam/atlas — it should auto-reply 'ACK' to new issue comments. CRITICAL: GitHub sends an automatic `ping` event when the webhook is first registered (and sometimes periodically) — that payload has no `issue` or `comment` field. The agent MUST tolerate that without crashing. Show me the agent code.";

// Live QA observed (BB iter 5/5, 2026-05-16): chat authored a Python user
// agent reading `ctx.env.get("BITBUCKET_API_TOKEN")` + `ctx.env.get("BITBUCKET_EMAIL")`.
// The agent.py had `environment={"required":[...]}` listing both vars — but
// the chat OMITTED the workspace.yml `agents.bb-pr-ack.env:` block. Result:
// ctx.env was {} at runtime, agent errored "BITBUCKET_EMAIL or BITBUCKET_API_TOKEN
// not configured" on first delivery. The skill now teaches: for every
// ctx.env.get(KEY) the agent calls, workspace.yml MUST declare
// `agents.<id>.env: { KEY: from_environment }`.
const USER_QUESTION_CTX_ENV_WIRING =
  "Draft the complete workspace.yml + Python user agent for a Bitbucket PR-comment webhook handler. The agent posts an ACK comment back to Bitbucket using Basic auth — it needs BITBUCKET_API_TOKEN and BITBUCKET_EMAIL (which I've put in ~/.atlas/.env). Show me BOTH the workspace.yml `agents:` block AND the Python agent.py — the secrets must reach `ctx.env` at runtime so `ctx.env.get('BITBUCKET_API_TOKEN')` returns the actual token, not empty.";

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
        "Explains the cycle mechanism: a comment posted by the agent fires the webhook → agent runs → posts again",
      // The model can spell the cycle out in several natural ways:
      //   - prose: "your comment fires the webhook"
      //   - directional verb on a webhook/signal/agent
      //   - arrow-chain notation: "Your agent posts ACK → Bitbucket fires X
      //     → agent sees comment → posts ACK again → repeat"
      // Accept any of them. Bare "trigger" alone is too weak (the user
      // question and workspace context already use it).
      pass:
        /\b(?:fires?|triggers?|invokes?|re-?fires?|re-?triggers?)\s+(?:the\s+|your\s+|another\s+|a new\s+|a\s+)?(?:webhook|signal|agent)/i.test(
          result.text,
        ) ||
        /\b(?:your|the agent'?s|the bot'?s|its own)\s+(?:comment|post|reply)\b[^.\n]{0,80}\b(?:fires?|triggers?|invokes?|re-?fires?|re-?triggers?|causes?)/i.test(
          result.text,
        ) ||
        /\bcomment\b[^.\n]{0,40}\b(?:fires?|triggers?|invokes?)\b[^.\n]{0,40}\b(?:webhook|signal|agent)/i.test(
          result.text,
        ) ||
        // Arrow-chain notation: a "→" or "->" between an agent/bot/post
        // and a webhook/fires/triggers token, paired with a second arrow
        // showing the cycle (back to "post", "ACK", "again", "repeat",
        // "loop") within a short window.
        (() => {
          // Pull a window containing at least two arrow-like transitions.
          const arrowChains = result.text.match(
            /[^\n]{0,400}(?:→|->|⇒)[^\n]{0,400}(?:→|->|⇒)[^\n]{0,200}/g,
          );
          if (!arrowChains) return false;
          return arrowChains.some(
            (chain) =>
              /\b(?:agent|bot|you|your\s+agent|webhook|fires?|triggers?|posts?)\b/i.test(chain) &&
              /\b(?:again|repeat|loop|cycle|infinit|ACK)\b/i.test(chain),
          );
        })() ||
        // Explicit walkthrough: "posts ACK" appearing twice within a
        // short window (or once + "again"/"repeat" nearby) shows the
        // cycle was spelled out.
        (() => {
          const m = result.text.match(
            /posts?\s+(?:["'`]?ACK["'`]?|a\s+(?:new\s+)?comment|its?\s+own)[\s\S]{0,400}/gi,
          );
          if (!m) return false;
          return m.some(
            (chunk) =>
              /\b(?:again|repeat|loop|cycle|infinit)\b/i.test(chunk) ||
              (chunk.match(/posts?\s+(?:["'`]?ACK["'`]?|a\s+(?:new\s+)?comment)/gi) || []).length >=
                2,
          );
        })(),
      evidence: result.text
        .match(
          /[^.\n]{0,80}\b(?:fires?|triggers?|invokes?|re-?fires?|re-?triggers?)\s+(?:the |your |another |a new |a )?(?:webhook|signal|agent)[^.\n]{0,80}|[^.\n]{0,80}(?:→|->)[^.\n]{0,200}(?:→|->)[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 300),
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
      pass:
        /\braw\b/i.test(text) &&
        !/(?:^|[^a-z])(?:two|both|2)\s+(?:built[-\s]?in\s+)?providers\b/i.test(text),
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
        "Recommends a non-`WEBHOOK_SECRET` env var name that the agent reads to verify the bitbucket HMAC secret",
      // Pass on ANY of:
      //   - Python env access naming a custom var: os.environ[...],
      //     os.environ.get(...), os.getenv(...)
      //   - Node env access: process.env.X, process.env["X"]
      //   - `friday env set <NAME>=` setter syntax for a non-WEBHOOK_SECRET name
      //   - Adjective phrasing (workspace-specific / dedicated / custom / etc.)
      //     near "env var" or "name" or "secret"
      //   - "WEBHOOK_SECRET is reserved for github" framing that pivots to
      //     a different name
      //   - Explicit "doesn't collide" / "non-colliding" framing
      pass: (() => {
        if (
          /\bos\.environ(?:\[['"][A-Z][A-Z0-9_]*['"]\]|\.get\(\s*['"][A-Z][A-Z0-9_]*['"])/.test(
            text,
          )
        )
          return true;
        if (/\bos\.getenv\(\s*['"][A-Z][A-Z0-9_]*['"]/.test(text)) return true;
        if (/\bprocess\.env(?:\.[A-Z][A-Z0-9_]+|\[['"][A-Z][A-Z0-9_]*['"]\])/.test(text))
          return true;
        if (
          /\bfriday\s+env\s+(?:set|add|put|update)\b[^.\n]{0,20}\b[A-Z][A-Z0-9_]{2,}\b/.test(text)
        )
          return true;
        if (
          /\b(?:workspace[-\s]?specific|project[-\s]?specific|dedicated|different|distinct|separate|custom|new|your\s+own|application[-\s]?specific|app[-\s]?specific)\b[^.\n]{0,80}\b(?:env(?:ironment)?\s+(?:var|variable)|name|secret|key)\b/i.test(
            text,
          )
        )
          return true;
        if (
          /\bWEBHOOK_SECRET\b[^.\n]{0,80}\b(?:reserved|github[-\s]?only|only\s+(?:for\s+)?(?:the\s+)?github|github\s+provider|doesn'?t\s+exist|no\s+longer)\b/i.test(
            text,
          )
        )
          return true;
        if (
          /\b(?:does(?:n'?t| not)\s+collide|non[-\s]?colliding|avoid(?:s)?\s+collision)\b/i.test(
            text,
          )
        )
          return true;
        // JSON body in API call: {"key": "<VARNAME>", "value": "..."} —
        // the agent is naming a custom env var via the env-set API.
        if (/['"]key['"]\s*:\s*['"][A-Z][A-Z0-9_]{2,}['"]/.test(text)) return true;
        // The agent put a specific custom var name in a code block / env
        // file snippet (any UPPER_SNAKE_CASE name that isn't WEBHOOK_SECRET
        // itself).
        for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)) {
          const name = m[1] ?? "";
          if (name === "WEBHOOK_SECRET") continue;
          if (/SECRET|TOKEN|KEY|HMAC/.test(name)) return true;
        }
        return false;
      })(),
      evidence: text
        .match(
          /\bos\.environ(?:\[['"][A-Z][A-Z0-9_]*['"]\]|\.get\(\s*['"][A-Z][A-Z0-9_]*['"])|os\.getenv\(\s*['"][A-Z][A-Z0-9_]*['"]|process\.env(?:\.[A-Z][A-Z0-9_]+|\[['"][A-Z][A-Z0-9_]*['"]\])|friday\s+env\s+(?:set|add)[^.\n]{0,40}|(?:workspace|project|app(?:lication)?)[-\s]?specific[^.\n]{0,80}|WEBHOOK_SECRET[^.\n]{0,80}reserved/i,
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
      id: "reads-payload-from-body",
      description:
        "References reading the raw body for HMAC computation — via ctx.input.config / ctx.input.raw OR by naming 'raw body' / 'body reaches the agent'",
      pass:
        /\bctx\.input\.(?:config|raw)\b/.test(text) ||
        /\b(?:raw|request)\s+body\b/i.test(text) ||
        /\bbody\b[^.\n]{0,40}\b(?:reaches?|arrives?|forwarded|passed)\s+(?:to\s+)?(?:your|the)\s+agent\b/i.test(
          text,
        ) ||
        /\bcompute\s+(?:the\s+)?HMAC\b[^.\n]{0,40}\bon\s+(?:the\s+)?(?:raw\s+)?body\b/i.test(
          text,
        ) ||
        /\b(?:only\s+the\s+body|body[-\s]?only)\b/i.test(text),
      evidence: text
        .match(
          /\bctx\.input\.(?:config|raw)\b|\b(?:raw|request)\s+body\b[^.\n]{0,60}|\bbody\b[^.\n]{0,80}/i,
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

async function runGithubLoopTrap(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (github-loop-trap)");
  const system = await buildSystemGithub();
  const result = await drive(system, USER_QUESTION_LOOP_TRAP_GITHUB);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "identifies-comment-subscription-loop",
      description:
        "Identifies that subscribing to issue_comment (the event the agent's own action creates) is the root cause",
      pass: /\bissue_comment|\bissue\s+comment|comment[-\s]?created|the comment event|your own comment[s]?|the agent'?s own (?:reply|comment)/i.test(
        text,
      ),
      evidence: text
        .match(/[^.\n]{0,80}(?:issue_comment|your own comment|comment\s+event)[^.\n]{0,80}/i)?.[0]
        ?.slice(0, 200),
    },
    {
      id: "prescribes-content-or-author-guard",
      description:
        "Prescribes either a content guard (skip if body matches marker) or an author guard (skip if commenter is the bot)",
      pass:
        /\b(?:skip|guard|check|ignore|filter)\b[^.\n]{0,80}\b(?:body|content|equals?\s*['"]?ACK|author|user|login|sender|identity|self|own|bot)/i.test(
          text,
        ) || /\bbefore (?:post|reply|sending)/i.test(text),
      evidence: text
        .match(
          /\b(?:skip|guard|check|ignore|filter)\b[^.\n]{0,80}\b(?:body|content|author|user|login|sender|identity|self|own|bot|ACK)[^.\n]{0,40}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "mentions-loop-mechanism",
      description:
        "Explains the cycle mechanism: agent posts a comment → fires webhook → agent runs → posts again",
      pass:
        /\b(?:fires?|triggers?|invokes?|re-?fires?|re-?triggers?)\s+(?:the\s+|your\s+|another\s+|a new\s+|a\s+)?(?:webhook|signal|agent)/i.test(
          text,
        ) ||
        /\b(?:your|the agent'?s|the bot'?s|its own)\s+(?:comment|post|reply)\b[^.\n]{0,80}\b(?:fires?|triggers?|invokes?|re-?fires?|re-?triggers?|causes?)/i.test(
          text,
        ) ||
        (() => {
          const chains = text.match(/[^\n]{0,400}(?:→|->|⇒)[^\n]{0,400}(?:→|->|⇒)[^\n]{0,200}/g);
          if (!chains) return false;
          return chains.some(
            (c) =>
              /\b(?:agent|bot|you|your\s+agent|webhook|fires?|triggers?|posts?)\b/i.test(c) &&
              /\b(?:again|repeat|loop|cycle|infinit|ACK)\b/i.test(c),
          );
        })(),
      evidence: text
        .match(
          /[^.\n]{0,80}\b(?:fires?|triggers?|invokes?|re-?fires?|re-?triggers?)\s+(?:the |your |another |a new |a )?(?:webhook|signal|agent)[^.\n]{0,80}|[^.\n]{0,80}(?:→|->)[^.\n]{0,200}(?:→|->)[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 300),
    },
    {
      id: "no-sleep-or-rate-limit-remedy",
      description:
        "does NOT prescribe a sleep / rate-limit / debounce as the fix (those don't break the cycle)",
      pass:
        !/\b(?:add|insert|use|with)\s+(?:a |an )?(?:sleep|delay|debounce|rate[\s-]?limit|throttle|backoff)\b[^.\n]{0,60}(?:between|before|to (?:slow|prevent|fix|stop)|to avoid)/i.test(
          text,
        ) &&
        !/\b(?:rate[\s-]?limit|throttle)\b[^.\n]{0,40}(?:will (?:fix|prevent|stop)|breaks the (?:loop|cycle))/i.test(
          text,
        ),
      evidence: text
        .match(/\b(?:sleep|delay|debounce|rate[\s-]?limit|throttle|backoff)\b[^.\n]{0,80}/i)?.[0]
        ?.slice(0, 160),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "github-loop-trap", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "github-loop-trap", pass: false, notes, metrics };
}

async function runGithubHmacInAgent(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (github-hmac-in-agent)");
  const system = await buildSystemGithub();
  const result = await drive(system, USER_QUESTION_GITHUB_HMAC);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "explains-tunnel-drops-headers",
      description:
        "Explains the tunnel forwards body only and drops X-Hub-Signature-256, so the agent can't compare against what GitHub sent",
      pass:
        /\b(?:tunnel|raw)\b[^.\n]{0,80}\b(?:drops?\s+headers?|body\s+only|no(?:t)?\s+(?:forward|relay)\s+headers?)/i.test(
          text,
        ) ||
        /\bX-Hub-Signature[^.\n]{0,80}\b(?:doesn'?t|does\s+not|won'?t|will\s+not)\s+reach/i.test(
          text,
        ) ||
        /\b(?:header(?:s)?\s+(?:never\s+)?(?:reach|arrive|forwarded))\b/i.test(text),
      evidence: text
        .match(
          /\b(?:tunnel|raw)\b[^.\n]{0,80}\b(?:drops?\s+headers?|body\s+only|no(?:t)?\s+forward)|\bX-Hub-Signature[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "recommends-trust-tunnel-boundary-or-custom-shape",
      description:
        "Either recommends trusting the tunnel-URL boundary OR proposes a custom signature scheme that doesn't depend on the dropped header",
      pass:
        /\btrust\b[^.\n]{0,80}\b(?:tunnel|URL|cloudflared)\s+(?:URL|boundary)?\b/i.test(text) ||
        /\bURL\b[^.\n]{0,40}\bboundary\b/i.test(text) ||
        /\bsecret\b[^.\n]{0,80}\b(?:in\s+(?:the\s+)?(?:body|URL|path|query|payload)|via\s+(?:a\s+)?(?:body|URL|path|query))/i.test(
          text,
        ) ||
        /\b(?:cloudflared|trycloudflare)\b[^.\n]{0,80}\b(?:rotat|random|guess)/i.test(text),
      evidence: text
        .match(
          /\btrust\b[^.\n]{0,80}\b(?:tunnel|URL)|\bsecret\b[^.\n]{0,80}\b(?:body|URL|path|query)/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "no-claim-tunnel-verifies-github-hmac",
      description:
        "Does NOT claim the tunnel verifies the GitHub HMAC (it doesn't — there's no built-in github provider anymore)",
      pass: !/\b(?:tunnel|raw provider|webhook-tunnel|friday)\b[^.\n]{0,80}\b(?:verif|check|validates?)\s+(?:the\s+)?(?:HMAC|signature)/i.test(
        text,
      ),
      evidence: text
        .match(
          /\b(?:tunnel|raw provider|webhook-tunnel|friday)\b[^.\n]{0,80}\b(?:verif|check|validates?)[^.\n]{0,40}(?:HMAC|signature)/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "no-friday-level-secret-claim",
      description:
        "Does NOT claim WEBHOOK_SECRET / GITHUB_WEBHOOK_SECRET is a Friday-level reserved env var the tunnel/atlasd reads",
      pass: !/\b(?:friday|atlasd|tunnel|webhook[-\s]?tunnel)\b[^.\n]{0,80}\b(?:reads?|looks?\s+(?:for|up)|recognizes?|honors?|checks?\s+(?:for|the))\b[^.\n]{0,60}\b(?:GITHUB|JIRA|BITBUCKET)?_?WEBHOOK_SECRET\b/i.test(
        text,
      ),
      evidence: text
        .match(
          /\b(?:friday|atlasd|tunnel)\b[^.\n]{0,80}\b(?:reads?|looks?|recognizes?|honors?|checks?)\b[^.\n]{0,80}WEBHOOK_SECRET/i,
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
    return { id: "github-hmac-in-agent", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "github-hmac-in-agent", pass: false, notes, metrics };
}

// ───── Scenario: tools must be declared when prompt invokes them ─────────

async function runAgentToolsMustBeDeclared(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (agent-tools-must-be-declared)");
  const system = await buildSystemGithub();
  const result = await drive(system, USER_QUESTION_AGENT_TOOLS_REQUIRED);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "tools-declared-not-empty",
      description:
        "The agent's `tools:` array is non-empty when the prompt invokes external commands (bash/gh/curl/MCP)",
      // The right shapes: `tools: [bash]`, `tools: ['bash']`, `tools: [bash, ...]`,
      // `tools:` followed by a non-empty YAML list, or `tools:` containing an MCP
      // tool like `serverId/toolName`. The wrong shape: literal `tools: []`.
      pass: (() => {
        // Fail if there's an explicit empty array.
        if (/\btools\s*:\s*\[\s*\]/m.test(text)) return false;
        // Pass if we can find a non-empty tools declaration somewhere.
        if (/\btools\s*:\s*\[[^\]\n]{1,200}\]/m.test(text)) return true;
        // YAML block-list form: `tools:` followed by a `- something` line.
        if (/\btools\s*:\s*\n(?:\s*-\s+\S)/m.test(text)) return true;
        // Inline form like `tools: [bash]` with whitespace tolerance.
        if (/\btools\s*:\s*\[\s*[A-Za-z_]/.test(text)) return true;
        return false;
      })(),
      evidence: text
        .match(/\btools\s*:[^\n]{0,160}(?:\n\s*-\s*[^\n]{0,80}){0,4}/)?.[0]
        ?.slice(0, 200),
    },
    {
      id: "names-bash-or-mcp-tool",
      description:
        "Names a concrete callable: `bash` (or `run_code`/`shell`) for shelling out to gh CLI, OR a github MCP tool (e.g. `create_issue_comment`)",
      pass:
        /\btools\s*:[\s\S]{0,400}\b(?:bash|run_code|shell|exec)\b/.test(text) ||
        /\btools\s*:[\s\S]{0,400}\b(?:create_issue_comment|add_issue_comment|post_comment|add_pull_request_comment)\b/.test(
          text,
        ) ||
        /\btools\s*:[\s\S]{0,400}\bgithub[/_-]/.test(text),
      evidence: text
        .match(/\btools\s*:[^\n]{0,80}(?:\n\s*-\s*[^\n]{0,80}){0,5}/)?.[0]
        ?.slice(0, 240),
    },
    {
      id: "no-phantom-success-prompt",
      description:
        "Prompt does NOT instruct the agent to just call `complete` and declare success without actually posting (this is the phantom-ACK failure mode)",
      // Fail if the prompt body contains a "just call complete with success" pattern
      // without first mentioning the actual tool. This is hard to detect perfectly;
      // approximate: if `complete` is mentioned and bash/gh/MCP-tool is NOT, it's
      // phantom-success-shaped.
      pass: (() => {
        const promptMatch = text.match(/prompt\s*:[\s\S]{0,3000}/);
        if (!promptMatch) return true;
        const promptBody = promptMatch[0];
        const mentionsComplete =
          /\bcomplete\s*\(/.test(promptBody) || /\bcall\s+complete\b/i.test(promptBody);
        if (!mentionsComplete) return true;
        const hasActualToolMention =
          /\b(?:bash|run_code|gh\s+api|curl|github[/_]|create_issue_comment|add_issue_comment|add_pull_request_comment|post_comment|MCP\s+tool)\b/i.test(
            promptBody,
          );
        return hasActualToolMention;
      })(),
      evidence: text.match(/\bcomplete\s*\([^\n]{0,80}/)?.[0]?.slice(0, 160),
    },
    {
      id: "warns-or-uses-correct-pattern",
      description:
        "Either explicitly warns that empty tools causes phantom success, OR demonstrates the right pattern by populating tools with a callable",
      pass:
        /\b(?:empty\s+tools|tools\s*:\s*\[\s*\]|no\s+tools|without\s+(?:declaring|the\s+tool))\b[^.\n]{0,140}\b(?:hallucin|fake|phantom|no(?:t)?\s+(?:call|actually|invoke))/i.test(
          text,
        ) ||
        /\b(?:hallucin|fake|phantom)\b[^.\n]{0,80}\b(?:success|complete|ACK)/i.test(text) ||
        // OR positive: prompt mentions a verb and tools contains the matching callable
        (/\b(?:bash|run_code|gh\s+api|curl)\b/i.test(text) &&
          /\btools\s*:[\s\S]{0,200}\b(?:bash|run_code|shell|github[/_])/i.test(text)),
      evidence: text
        .match(
          /\b(?:empty\s+tools|hallucin|fake|phantom)\b[^.\n]{0,160}|\btools\s*:[\s\S]{0,160}\b(?:bash|run_code|github)/i,
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
    return { id: "agent-tools-must-be-declared", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "agent-tools-must-be-declared", pass: false, notes, metrics };
}

// ───── Scenario: loop guard must be deterministic (not LLM-only) ────────

async function runLoopGuardDeterministic(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (loop-guard-deterministic-not-llm-only)");
  const system = await buildSystemGithub();
  const result = await drive(system, USER_QUESTION_LOOP_GUARD_RELIABILITY);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "uses-unique-marker-pattern",
      description:
        "Recommends embedding a unique high-entropy token (e.g. [fri-bot-v1], an emoji prefix, or a UUID-like marker) in the bot reply that the guard checks for — NOT just 'skip if starts with ACK'",
      pass:
        /\[[a-z][a-z0-9_-]{2,}-bot[a-z0-9_-]*\]|\[fri-bot[^\]]*\]/i.test(text) ||
        /\b(?:unique|distinct|high[-\s]?entropy|literal\s+token|marker\s+token)\b[^.\n]{0,80}\b(?:reply|body|comment)/i.test(
          text,
        ) ||
        /[\u{1F300}-\u{1F9FF}]/u.test(text) ||
        /\bcontains?\s*\(\s*['"`]\[[^\]]+\]['"`]\s*\)/i.test(text) ||
        /\bbody\s*\.?\s*(?:contains?|indexOf|includes?)\b[^.\n]{0,40}\[[^\]]+\]/i.test(text),
      evidence: text
        .match(
          /\[[a-z][a-z0-9_-]{2,}[-_]?bot[^\]]*\]|\b(?:unique|distinct|high[-\s]?entropy|literal\s+token|marker)\b[^.\n]{0,80}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "warns-llm-content-guard-unreliable-or-uses-deterministic",
      description:
        "Either explicitly warns that LLM-prompt content guards are unreliable, OR shifts to a deterministic guard (Python user agent / signal-level filter)",
      pass:
        /\b(?:unreliable|drift|ignore[ds]?|miss|skip[s]?\s+the\s+(?:guard|check))\b[^.\n]{0,80}\b(?:LLM|prompt|model|instruction)/i.test(
          text,
        ) ||
        /\b(?:LLM|prompt|model)\b[^.\n]{0,80}\b(?:unreliable|drift|ignore|miss|not\s+reliable|fail\s+to)/i.test(
          text,
        ) ||
        /\btype\s*:\s*user\b[\s\S]{0,400}\b(?:guard|loop|skip|deterministic)/i.test(text) ||
        /\bdeterministic\s+(?:guard|check|loop[-\s]?guard)/i.test(text) ||
        /\b(?:Python|@agent|ctx\.input)\b[\s\S]{0,300}\b(?:guard|loop|skip)/i.test(text),
      evidence: text
        .match(
          /\b(?:unreliable|drift|ignore[ds]?|deterministic|Python|@agent)\b[^.\n]{0,200}/i,
        )?.[0]
        ?.slice(0, 240),
    },
    {
      id: "guard-checked-first-in-prompt",
      description:
        "If using an LLM agent, the loop guard is positioned FIRST in the prompt (before any other reasoning), not buried at the end",
      pass:
        /\b(?:loop\s+guard|LOOP\s+GUARD)\b[^.\n]{0,80}\b(?:do\s+this\s+first|check\s+(?:this\s+)?first|before\s+any|step\s+1|first\s+step)/i.test(
          text,
        ) ||
        /\b(?:first|step\s+1|before)\b[^.\n]{0,80}\b(?:guard|skip|check\s+(?:the\s+)?body)/i.test(
          text,
        ),
      evidence: text.match(/\b(?:loop\s+guard|first|step\s+1)\b[^.\n]{0,200}/i)?.[0]?.slice(0, 240),
    },
    {
      id: "no-naive-starts-with-ack-only",
      description:
        "Does NOT recommend ONLY a naive `body.startsWith('ACK')` check — that's the failure mode we just hit live",
      pass: (() => {
        const naive =
          /\b(?:startsWith|starts\s+with|begins\s+with|contains)\s*\(?[\s'"`]*ACK['"`]?\)?/i.test(
            text,
          );
        if (!naive) return true;
        const stronger =
          /\[[a-z][a-z0-9_-]{2,}[-_]?bot[^\]]*\]/i.test(text) ||
          /\bunique\s+(?:marker|token)/i.test(text) ||
          /\btype\s*:\s*user\b/i.test(text) ||
          /\bdeterministic\b/i.test(text) ||
          /\bemoji\b[^.\n]{0,80}\b(?:marker|prefix|guard)/i.test(text);
        return stronger;
      })(),
      evidence: text
        .match(
          /\b(?:startsWith|starts\s+with|begins\s+with|contains)\s*\(?[\s'"`]*ACK['"`]?\)?[^.\n]{0,80}/i,
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
    return { id: "loop-guard-deterministic-not-llm-only", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "loop-guard-deterministic-not-llm-only", pass: false, notes, metrics };
}

// ───── Scenario: dynamic identifiers via bash, not MCP tool args ────────

async function runReplyViaBashNotMcp(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (reply-via-bash-not-mcp-args)");
  const system = await buildSystemGithub();
  const result = await drive(system, USER_QUESTION_REPLY_VIA_BASH_NOT_MCP);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "recommends-bash-cli-not-mcp",
      description:
        "Recommends option (b) — bash + gh CLI — as the right pattern for dynamic identifiers like issue_number",
      pass:
        /\b(?:option\s+)?[([]?b[)\]]?\b[^.\n]{0,200}\b(?:bash|gh\s+api|gh\s+CLI|shell|command\s+string)/i.test(
          text,
        ) ||
        /\b(?:bash|gh\s+CLI|gh\s+api)\b[^.\n]{0,200}\b(?:recommend|right|preferred|correct|better|use\s+this|reliable|safer|robust)/i.test(
          text,
        ) ||
        /\b(?:recommend|prefer|use)\b[^.\n]{0,80}\b(?:bash|gh\s+CLI|gh\s+api|shell)/i.test(text),
      evidence: text.match(/\b(?:bash|gh\s+(?:CLI|api))[^.\n]{0,200}/i)?.[0]?.slice(0, 240),
    },
    {
      id: "warns-mcp-args-hallucinated",
      description:
        "Warns that LLM-generated MCP tool args can be hallucinated when carrying dynamic webhook fields",
      pass:
        /\b(?:hallucin|wrong\s+value|made[-\s]?up|invent|drift|ignore[ds]?|guess)\b[^.\n]{0,160}\b(?:arg|argument|tool|value|number|id)/i.test(
          text,
        ) ||
        /\bMCP\s+tool[^.\n]{0,160}\b(?:hallucin|wrong|unreliable|drift|ignore|guess)/i.test(text) ||
        /\bLLM\b[^.\n]{0,120}\b(?:picks?|chooses?|generates?|invents?)\b[^.\n]{0,80}\b(?:arg|value)/i.test(
          text,
        ),
      evidence: text
        .match(/\b(?:hallucin|wrong\s+value|made[-\s]?up|invent|drift|ignored)[^.\n]{0,200}/i)?.[0]
        ?.slice(0, 240),
    },
    {
      id: "command-string-substitution-rationale",
      description:
        "Explains the rationale: with bash, the dynamic identifier lands in the command STRING at template-substitution time, before the LLM gets involved",
      pass:
        /\b(?:command\s+string|baked\s+into|interpolat|substitut|template[-\s]?substitut|render|hard[-\s]?coded\s+into)/i.test(
          text,
        ) ||
        /\b(?:before|prior to)\b[^.\n]{0,60}\b(?:LLM|model)\b[^.\n]{0,60}\b(?:sees|acts|picks|generates|invokes)/i.test(
          text,
        ) ||
        /\b(?:value|number|id)\b[^.\n]{0,120}\b(?:in|inside|part\s+of)\s+(?:the\s+)?command\b/i.test(
          text,
        ),
      evidence: text
        .match(
          /\b(?:command\s+string|baked|interpolat|substitut|before\s+the\s+LLM)[^.\n]{0,200}/i,
        )?.[0]
        ?.slice(0, 240),
    },
    {
      id: "no-recommend-mcp-args-for-dynamic-ids",
      description:
        "Does NOT recommend (a) — passing dynamic webhook identifiers as MCP tool args — as the right answer",
      // Fail if option (a) is presented as recommended / preferred / OK.
      pass: !/\b(?:option\s+)?[([]?a[)\]]?\b[^.\n]{0,160}\b(?:recommend|right|preferred|correct|better|use\s+this|reliable|safer|the\s+(?:right|cleanest|preferred))/i.test(
        text,
      ),
      evidence: text.match(/\b(?:option\s+)?[([]?a[)\]]?\b[^.\n]{0,200}/i)?.[0]?.slice(0, 240),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "reply-via-bash-not-mcp-args", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "reply-via-bash-not-mcp-args", pass: false, notes, metrics };
}

// ───── Scenario: agent must tolerate upstream's ping/test events ─────

async function runAgentTolerancesPing(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (agent-tolerates-ping-events)");
  const system = await buildSystemGithub();
  const result = await drive(system, USER_QUESTION_PING_EVENT_TOLERANCE);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  const checks: ContractCheck[] = [
    {
      id: "guards-missing-issue-key",
      description:
        "Agent code guards against missing `issue` or `comment` key in payload (e.g. `if 'issue' not in payload`, `payload.get('issue')`, `try/except KeyError`)",
      pass:
        /\bif\b[^.\n]{0,40}\b(?:not\s+in|"issue"\s+not\s+in|'issue'\s+not\s+in|not\s+(?:payload|p)\.get\(|missing)\b/i.test(
          text,
        ) ||
        /\.get\(\s*["']issue["']\s*[,)]/.test(text) ||
        /\.get\(\s*["']comment["']\s*[,)]/.test(text) ||
        /\btry\s*:[\s\S]{0,300}\bexcept\s+(?:KeyError|Exception)/i.test(text) ||
        /\bif\b[^.\n]{0,80}\b(?:issue|comment)\b[^.\n]{0,40}\b(?:in\s+payload|present|exists?)/i.test(
          text,
        ),
      evidence: text
        .match(
          /\b(?:if\s+["']?issue["']?\s+not\s+in|\.get\(\s*["'](?:issue|comment)["']|try\s*:[\s\S]{0,200}except\s+KeyError|if\s+(?:not\s+)?payload\.get)[^\n]{0,200}/i,
        )?.[0]
        ?.slice(0, 240),
    },
    {
      id: "names-ping-or-setup-event",
      description:
        "Explicitly mentions GitHub's ping event (or 'setup test', 'hook-creation event', 'zen' field) as the failure mode being guarded",
      pass:
        /\b(?:ping\s+event|ping\s+payload|hook[-\s]?creation|setup[-\s]?test|test\s+event)\b/i.test(
          text,
        ) ||
        /\bzen\b[^.\n]{0,80}\b(?:field|key|payload)/i.test(text) ||
        /\bGitHub\b[^.\n]{0,80}\bping\b/i.test(text),
      evidence: text
        .match(
          /\b(?:ping|hook[-\s]?creation|setup[-\s]?test|test\s+event|zen)\b[^.\n]{0,160}/i,
        )?.[0]
        ?.slice(0, 200),
    },
    {
      id: "returns-skip-not-crash",
      description:
        "Returns gracefully (ok({skipped: ...}) / early return / log+return) on missing fields, does NOT raise / re-raise unconditionally",
      pass:
        /\breturn\s+ok\s*\(\s*\{\s*["']?skipped/i.test(text) ||
        /\breturn\s+ok\s*\(/i.test(text) ||
        /\breturn\s+(?:None|early|gracefully)/i.test(text) ||
        /\bcontinue\b|\bpass\b\s*(?:#|$)/m.test(text),
      evidence: text
        .match(/\breturn\s+ok\([^.\n]{0,200}|\breturn\s+(?:None|gracefully)/i)?.[0]
        ?.slice(0, 200),
    },
    {
      id: "no-naive-bracket-extraction",
      description:
        "Does NOT do naive `payload['issue']['number']` extraction WITHOUT a guard above it",
      pass: (() => {
        const naive = /payload\s*\[\s*["']issue["']\s*\]\s*\[\s*["']number["']\s*\]/i.test(text);
        if (!naive) return true;
        // Tolerate if there's also a guard/try/get/in-check nearby.
        const guarded =
          /\b(?:if|try|except|\.get\()/i.test(text) &&
          /\b(?:issue|comment)\b[^.\n]{0,40}\b(?:in\s+payload|not\s+in|present|exists?|missing)/i.test(
            text,
          );
        return guarded;
      })(),
      evidence: text
        .match(/payload\s*\[\s*["']issue["']\s*\]\s*\[\s*["']number["']\s*\]/i)?.[0]
        ?.slice(0, 160),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "agent-tolerates-ping-events", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "agent-tolerates-ping-events", pass: false, notes, metrics };
}

// ───── Scenario: ctx.env requires workspace.yml `agents.<id>.env:` wiring ─

async function runCtxEnvWiring(): Promise<EvalResult> {
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};

  console.log("  → drive (ctx-env-vars-need-workspace-yml-wiring)");
  const system = await buildSystemGithub();
  const result = await drive(system, USER_QUESTION_CTX_ENV_WIRING);
  metrics.durationMs = result.durationMs;
  metrics.responseLen = result.text.length;
  metrics.responseFull = result.text;

  const text = result.text;

  // Locate the workspace.yml `agents.<id>.env:` block (the wiring under an
  // agent declaration, NOT the agent.py `environment={...}` block which is
  // documentation only).
  // Shape we want:
  //   agents:
  //     bb-pr-ack:
  //       type: user
  //       agent: bb-pr-ack
  //       env:
  //         BITBUCKET_API_TOKEN: from_environment
  //         BITBUCKET_EMAIL:     from_environment
  const yamlEnvBlock = text.match(
    /\b(?:type\s*:\s*user|agent\s*:\s*[\w-]+)[\s\S]{0,400}?\benv\s*:\s*\n(?:\s+[A-Z][A-Z0-9_]*\s*:[^\n]*\n){1,12}/,
  )?.[0];

  const checks: ContractCheck[] = [
    {
      id: "wires-ctx-env-in-workspace-yml",
      description:
        "workspace.yml `agents.<id>.env:` block declares the secret vars (so ctx.env receives them) — NOT just agent.py's `environment.required` block",
      pass:
        // Must find `env:` under an agent declaration with at least one of
        // the bitbucket vars listed as a key.
        /(?:type\s*:\s*user|agent\s*:\s*[\w-]+)[\s\S]{0,400}?\benv\s*:\s*\n\s+BITBUCKET_(?:API_TOKEN|EMAIL)\s*:/i.test(
          text,
        ),
      evidence: yamlEnvBlock?.slice(0, 240),
    },
    {
      id: "uses-from-environment-or-link-ref",
      description:
        "Each declared var resolves via `from_environment` / `auto` / a Link credential ref (`{ from: link, ... }`) — NOT a template string like `'{{env.X}}'`, `'${X}'`, or `'$X'` (resolveEnvValues does not interpolate; templates land as literal strings and cause 401s)",
      pass: (() => {
        if (!yamlEnvBlock) return false;
        const lines = yamlEnvBlock.split("\n").filter((l) => /^\s+BITBUCKET_[A-Z_]+\s*:/.test(l));
        if (lines.length === 0) return false;
        // Reject any template-style RHS — the resolver doesn't interpolate.
        const hasTemplateString = lines.some((l) =>
          /:\s*['"]?\s*(?:\{\{\s*env\.|\$\{|\$[A-Z_])/i.test(l),
        );
        if (hasTemplateString) return false;
        return lines.every((l) =>
          /:\s*(?:from_environment|auto|\{\s*from\s*:\s*link\b[^}]*\})/i.test(l),
        );
      })(),
      evidence: yamlEnvBlock?.slice(0, 240),
    },
    {
      id: "does-not-claim-environment-required-is-sufficient",
      description:
        "Does NOT falsely claim that agent.py's `environment={'required':[...]}` block alone is enough to populate ctx.env (would be the trap that caused the live failure).",
      // Fail only on the dangerous positive claim ("the environment block
      // makes ctx.env get the vars" / "required field wires them in"). We
      // don't require the model to volunteer a why-essay — the behavioral
      // signal is the correct workspace.yml wiring (covered by the other
      // checks). This guard catches the case where it explains incorrectly.
      pass: (() => {
        const falseClaim =
          /\benvironment\s*=?\s*\{?[^}]*required\b[^.\n]{0,200}\b(?:populate|wires?|inject|provide(?:s)?|supplies?|loads?|reads?)\b[^.\n]{0,80}\bctx\.env\b/i.test(
            text,
          ) ||
          /\brequired\s+(?:field|list|block)\b[^.\n]{0,160}\b(?:populate|wires?|inject|provide(?:s)?|loads?)\b[^.\n]{0,80}\b(?:env(?:ironment)?|ctx)/i.test(
            text,
          );
        return !falseClaim;
      })(),
      evidence: text
        .match(
          /\benvironment\s*=?\s*\{[^}]*required[^.\n]{0,200}|\brequired\s+(?:field|list|block)[^.\n]{0,200}/i,
        )?.[0]
        ?.slice(0, 240),
    },
    {
      id: "agent-actually-reads-via-ctx-env",
      description:
        "Agent code reads via `ctx.env.get(...)` (or `ctx.env[...]`) — confirms the wiring it's setting up matches the read path",
      pass:
        /\bctx\.env\s*\.\s*get\s*\(\s*["']BITBUCKET_(?:API_TOKEN|EMAIL)["']/.test(text) ||
        /\bctx\.env\s*\[\s*["']BITBUCKET_(?:API_TOKEN|EMAIL)["']\s*\]/.test(text),
      evidence: text
        .match(/\bctx\.env(?:\.get\(|\[)\s*["']BITBUCKET_[A-Z_]+["']\s*[,)\]]/)?.[0]
        ?.slice(0, 160),
    },
  ];

  metrics.checks = checks;
  const failed = checks.filter((c) => !c.pass);

  if (failed.length === 0) {
    notes.push(`Positive: all ${checks.length} checks passed.`);
    for (const c of checks)
      notes.push(`  ✓ ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`);
    return { id: "ctx-env-vars-need-workspace-yml-wiring", pass: true, notes, metrics };
  }
  notes.push(`Negative: ${failed.length}/${checks.length} failed.`);
  for (const c of checks)
    notes.push(
      `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.description}${c.evidence ? ` [${c.evidence}]` : ""}`,
    );
  notes.push(`Reply head: "${result.text.slice(0, 400)}"`);
  return { id: "ctx-env-vars-need-workspace-yml-wiring", pass: false, notes, metrics };
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
    { id: "no-atlasd-url-fallback", fn: () => runNoAtlasdUrlFallback() },
    { id: "webhook-signal-schema-passes-body", fn: () => runWebhookSignalSchema() },
    { id: "github-setup-walkthrough", fn: () => runGithubSetup() },
    { id: "github-loop-trap", fn: () => runGithubLoopTrap() },
    { id: "github-hmac-in-agent", fn: () => runGithubHmacInAgent() },
    { id: "agent-tools-must-be-declared", fn: () => runAgentToolsMustBeDeclared() },
    { id: "loop-guard-deterministic-not-llm-only", fn: () => runLoopGuardDeterministic() },
    { id: "reply-via-bash-not-mcp-args", fn: () => runReplyViaBashNotMcp() },
    { id: "agent-tolerates-ping-events", fn: () => runAgentTolerancesPing() },
    { id: "ctx-env-vars-need-workspace-yml-wiring", fn: () => runCtxEnvWiring() },
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
