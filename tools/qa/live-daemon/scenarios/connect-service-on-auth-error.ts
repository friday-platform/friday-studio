#!/usr/bin/env -S deno run --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports --env-file

/**
 * Supervisor connect_service eval.
 *
 * When an enabled MCP server (in `<workspace><mcp_servers>`) returns a
 * credential-missing error at runtime, the workspace-chat supervisor
 * must call `connect_service(<provider>)` to render the inline connect
 * card — not regurgitate the error as prose telling the user to "go to
 * Settings". The directive lives in
 * `packages/system/agents/workspace-chat/prompt.txt` under
 * `<service_connection>` (Enabled-but-no-credential branch); the
 * underlying error string comes from `NoDefaultCredentialError` in
 * `packages/core/src/mcp-registry/credential-resolver.ts`.
 *
 * The eval pairs each behavioral assertion with a causal control
 * (with-directive vs. without-directive) so a regression in either the
 * prompt or the error message surfaces here.
 */

import { ensureDir } from "jsr:@std/fs@1.0.13/ensure-dir";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { currentGitSha, ensureCredentialsLoaded, HARNESS_PATHS } from "../harness.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  notes: string[];
  metrics: Record<string, unknown>;
}

const REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..", "..", "..");
const WORKSPACE_CHAT_PROMPT = join(REPO_ROOT, "packages/system/agents/workspace-chat/prompt.txt");

// Minimal harness around the directive under test. Workspace context +
// `connect_service` tool description are eval-specific scaffolding (the
// production prompt builds those dynamically at chat-start, so we can't
// re-use them here). The <service_connection> block itself is read from
// the production prompt at runtime — see extractServiceConnection() — so
// there's no duplicated copy to drift.
const HARNESS_HEADER = `You are the workspace-chat supervisor agent inside Friday.

The user is in workspace \`user\`. Workspace context:

  <workspace id="user" name="Personal">
    <agents>gcal-fetch-agent</agents>
    <mcp_servers>google-calendar</mcp_servers>
  </workspace>

You have a tool called \`connect_service(provider)\` that starts an OAuth
connect flow for the named provider and renders an inline "Connect <X>"
card the user can click. Provider IDs come from <mcp_servers> or
list_integrations.`;

// Extract the <service_connection>...</service_connection> block from the
// production workspace-chat prompt. If the markers move or get renamed,
// this throws — the eval refuses to silently validate against a stale
// snapshot.
async function extractServiceConnection(): Promise<string> {
  const full = await Deno.readTextFile(WORKSPACE_CHAT_PROMPT);
  const match = full.match(/<service_connection>[\s\S]*?<\/service_connection>/);
  if (!match) {
    throw new Error(
      `extractServiceConnection: no <service_connection> block found in ${WORKSPACE_CHAT_PROMPT}`,
    );
  }
  return match[0].trim();
}

// Strip the "Enabled-but-no-credential" paragraph for the control prompt.
// The paragraph is one logical block delimited by blank lines, so we drop
// it whole rather than line-by-line — keeps the control faithful to the
// directive's location in the source.
function stripEnabledButNoCredentialBranch(block: string): string {
  return block
    .replace(/\n\nEnabled-but-no-credential[\s\S]*?(?=\n\n|<\/service_connection>)/, "")
    .replace(/\n{3,}/g, "\n\n");
}

async function buildPrompt(variant: "with-directive" | "without-directive"): Promise<string> {
  const block = await extractServiceConnection();
  const finalBlock =
    variant === "with-directive" ? block : stripEnabledButNoCredentialBranch(block);
  return `${HARNESS_HEADER}\n\n${finalBlock}\n`;
}

const USER_GOAL = "What's on my Google Calendar today?";
const PROVIDER = "google-calendar";

// Verbatim error string emitted by NoDefaultCredentialError after we
// dropped the "Go to Settings > Connections" tail. Keeping this in lockstep
// with the constructor in credential-resolver.ts is the point — if either
// side changes, both fail and force a deliberate update.
const NO_DEFAULT_ERROR = `No default credential set for ${PROVIDER}. Call connect_service to connect one.`;

// Tool the delegate sub-agent "used" (in our synthetic prior turn). Its
// result envelope is the same shape the real list_mcp_tools wraps the
// credential-resolver error in — `{ok:false, error, phase:"auth"}`.
const DELEGATE_AUTH_FAILURE_OUTPUT = {
  ok: false,
  reason: NO_DEFAULT_ERROR,
  toolsUsed: [
    {
      name: "list_mcp_tools",
      input: { serverId: PROVIDER },
      outcome: "success",
      summary: JSON.stringify({ ok: false, error: NO_DEFAULT_ERROR, phase: "auth" }),
    },
  ],
};

// Transient refresh-failure envelope. The credential is still valid; the
// Cloud Function or the network blipped. Calling connect_service here
// would force the user to re-auth a working refresh_token — a regression
// the directive's transient branch is meant to prevent. The string
// matches what Link's classifier surfaces (apps/link/src/routes/credentials.ts:441).
const TRANSIENT_NETWORK_ERROR =
  "transient refresh failure (network): error sending request for url (https://google-workspace-extension.geminicli.com/refreshToken): client error (Connect): tcp connect error: Connection refused (os error 61)";
const DELEGATE_TRANSIENT_FAILURE_OUTPUT = {
  ok: false,
  reason: TRANSIENT_NETWORK_ERROR,
  toolsUsed: [
    {
      name: "list_mcp_tools",
      input: { serverId: PROVIDER },
      outcome: "success",
      summary: JSON.stringify({ ok: false, error: TRANSIENT_NETWORK_ERROR, phase: "auth" }),
    },
  ],
};

// Dead-token envelope — RFC 6749 § 5.2 invalid_grant. Refresh_token is
// permanently dead; re-auth is correct. Pairs with the transient case so
// the eval proves the supervisor can tell them apart from the error text
// alone (the phase field is "auth" in both — only the message differs).
const DEAD_TOKEN_ERROR =
  "refresh failed: invalid_grant (Token has been expired or revoked.) — the credential was revoked or the refresh_token is no longer valid. Reconnect to continue.";
const DELEGATE_DEAD_TOKEN_OUTPUT = {
  ok: false,
  reason: DEAD_TOKEN_ERROR,
  toolsUsed: [
    {
      name: "list_mcp_tools",
      input: { serverId: PROVIDER },
      outcome: "success",
      summary: JSON.stringify({ ok: false, error: DEAD_TOKEN_ERROR, phase: "auth" }),
    },
  ],
};

// Happy-path delegate result the supervisor should NOT respond to with
// `connect_service`. We want to prove the directive fires only on the
// auth-error branch.
const EVENT_STANDUP = "G&E Standup";
const EVENT_FOUNDERS = "Founders' Check-in";
const DELEGATE_SUCCESS_OUTPUT = {
  ok: true,
  answer:
    `2 events on 2026-05-11 (America/Los_Angeles):\n` +
    `1. ${EVENT_STANDUP} — 11:00–11:30 — https://meet.google.com/bjr-fiyi-seu\n` +
    `2. ${EVENT_FOUNDERS} — 14:00–15:30 — https://meet.google.com/myc-edor-bao`,
  toolsUsed: [
    { name: "list_mcp_tools", outcome: "success" },
    { name: "google-calendar/get_events", outcome: "success" },
  ],
};

const TOOLS = [
  {
    name: "connect_service",
    description:
      "Render an inline 'Connect <provider>' card and start the OAuth connect flow. Use when an enabled MCP server's tool call fails because the credential is missing/expired/revoked.",
    input_schema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "Provider id from <mcp_servers> or list_integrations (e.g. google-calendar).",
        },
      },
      required: ["provider"],
    },
  },
  {
    name: "delegate",
    description:
      "Hand a sub-task to a delegate sub-agent. Pass `mcpServers` to scope its tool access. Returns `{ok, answer|reason, toolsUsed}`.",
    input_schema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        handoff: { type: "string" },
        mcpServers: { type: "array", items: { type: "string" } },
      },
      required: ["goal"],
    },
  },
  {
    name: "list_integrations",
    description: "List available integrations and their connection status.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "enable_mcp_server",
    description: "Enable an MCP server in the current workspace (after it's been connected).",
    input_schema: {
      type: "object",
      properties: { provider: { type: "string" } },
      required: ["provider"],
    },
  },
  {
    name: "finish",
    description:
      "End the supervisor turn with a short user-facing acknowledgment. Optional — you can also just stop.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface DriveResult {
  toolCalls: ToolCall[];
  text: string;
}

async function drive(
  systemPrompt: string,
  delegateResult: Record<string, unknown>,
): Promise<DriveResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const messages = [
    { role: "user", content: USER_GOAL },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool_delegate_1",
          name: "delegate",
          input: {
            goal: "Fetch Google Calendar events for today.",
            handoff: "Use the google-calendar MCP server to list events for 2026-05-11.",
            mcpServers: [PROVIDER],
          },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_delegate_1",
          content: JSON.stringify(delegateResult),
        },
      ],
    },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      temperature: 0,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    >;
  };
  const blocks = data.content ?? [];
  const toolCalls: ToolCall[] = blocks
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use",
    )
    .map((b) => ({ name: b.name, input: b.input }));
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { toolCalls, text };
}

// Heuristic: if the supervisor falls back to telling the user to "go to
// Settings", a UI-path that no longer exists. This is the canonical
// failure mode the directive removes.
function tellsUserToVisitSettings(text: string): boolean {
  return /settings\s*[>→/]/i.test(text) || /go to\s+settings/i.test(text);
}

async function runEval(): Promise<EvalResult[]> {
  const withDirective = await buildPrompt("with-directive");
  const withoutDirective = await buildPrompt("without-directive");

  console.log("  → Anthropic: failure path, directive ON");
  const onFail = await drive(withDirective, DELEGATE_AUTH_FAILURE_OUTPUT);
  console.log(
    `    toolCalls: ${onFail.toolCalls.map((c) => c.name).join(", ") || "(none)"}; textLen=${onFail.text.length}`,
  );

  console.log("  → Anthropic: failure path, directive OFF (control)");
  const offFail = await drive(withoutDirective, DELEGATE_AUTH_FAILURE_OUTPUT);
  console.log(
    `    toolCalls: ${offFail.toolCalls.map((c) => c.name).join(", ") || "(none)"}; textLen=${offFail.text.length}`,
  );

  console.log("  → Anthropic: success path, directive ON");
  const onSuccess = await drive(withDirective, DELEGATE_SUCCESS_OUTPUT);
  console.log(
    `    toolCalls: ${onSuccess.toolCalls.map((c) => c.name).join(", ") || "(none)"}; textLen=${onSuccess.text.length}`,
  );

  console.log("  → Anthropic: transient refresh failure, directive ON");
  const onTransient = await drive(withDirective, DELEGATE_TRANSIENT_FAILURE_OUTPUT);
  console.log(
    `    toolCalls: ${onTransient.toolCalls.map((c) => c.name).join(", ") || "(none)"}; textLen=${onTransient.text.length}`,
  );

  console.log("  → Anthropic: dead-token (invalid_grant) failure, directive ON");
  const onDead = await drive(withDirective, DELEGATE_DEAD_TOKEN_OUTPUT);
  console.log(
    `    toolCalls: ${onDead.toolCalls.map((c) => c.name).join(", ") || "(none)"}; textLen=${onDead.text.length}`,
  );

  const results: EvalResult[] = [];

  // --- Failure-path scenarios (the supervisor should connect_service) ---

  const onConnect = onFail.toolCalls.find(
    (c) => c.name === "connect_service" && String(c.input.provider) === PROVIDER,
  );
  results.push({
    id: "connect-service-on-auth-error-fires",
    pass: Boolean(onConnect),
    notes: [
      `connect_service called with provider=${PROVIDER}: ${Boolean(onConnect)}`,
      `tools called: ${onFail.toolCalls.map((c) => c.name).join(", ") || "(none)"}`,
      `text[:200]: ${onFail.text.slice(0, 200)}`,
    ],
    metrics: {
      called: Boolean(onConnect),
      providerMatch: String(onConnect?.input.provider) === PROVIDER,
      systemPrompt: withDirective,
    },
  });

  const onMentionsSettings = tellsUserToVisitSettings(onFail.text);
  results.push({
    id: "connect-service-on-auth-error-no-settings-prose",
    pass: !onMentionsSettings,
    notes: [
      `text references a Settings / Settings > Connections UI: ${onMentionsSettings}`,
      `text[:300]: ${onFail.text.slice(0, 300)}`,
      "Settings > Connections is not a real UI — the agent should call connect_service, not point at it.",
    ],
    metrics: { mentionsSettings: onMentionsSettings, systemPrompt: withDirective },
  });

  // Causal pair: with the directive, the supervisor must call connect_service
  // at least as often (in practice: strictly more often) than the control.
  const offConnect = offFail.toolCalls.find(
    (c) => c.name === "connect_service" && String(c.input.provider) === PROVIDER,
  );
  results.push({
    id: "connect-service-on-auth-error-directive-causal",
    pass: onConnect && !offConnect ? true : Boolean(onConnect) >= Boolean(offConnect),
    notes: [
      `directive ON → connect_service called: ${Boolean(onConnect)}`,
      `directive OFF (control) → connect_service called: ${Boolean(offConnect)}`,
      "Causal claim: adding the Enabled-but-no-credential branch should increase (or at minimum not decrease) the connect_service rate.",
    ],
    metrics: {
      onCalled: Boolean(onConnect),
      offCalled: Boolean(offConnect),
      systemPromptOn: withDirective,
      systemPromptOff: withoutDirective,
    },
  });

  // --- Success-path scenario (the supervisor should NOT connect_service) ---

  const successWronglyConnects = onSuccess.toolCalls.find((c) => c.name === "connect_service");
  const successMentionsEvents =
    onSuccess.text.includes(EVENT_STANDUP) || onSuccess.text.includes(EVENT_FOUNDERS);
  results.push({
    id: "connect-service-success-path-no-spurious-connect",
    pass: !successWronglyConnects,
    notes: [
      `connect_service called on success path: ${Boolean(successWronglyConnects)}`,
      `tools called: ${onSuccess.toolCalls.map((c) => c.name).join(", ") || "(none)"}`,
      "Directive must fire only on auth errors — calling connect_service after a successful delegate is a regression.",
    ],
    metrics: { spuriousConnect: Boolean(successWronglyConnects), systemPrompt: withDirective },
  });

  results.push({
    id: "connect-service-success-path-relays-events",
    pass: successMentionsEvents,
    notes: [
      `text references event markers (${EVENT_STANDUP} or ${EVENT_FOUNDERS}): ${successMentionsEvents}`,
      `text[:300]: ${onSuccess.text.slice(0, 300)}`,
      "Sanity check: when the delegate returns events, the supervisor should hand them back to the user.",
    ],
    metrics: { mentionsEvents: successMentionsEvents, systemPrompt: withDirective },
  });

  // --- Transient-failure scenarios (the supervisor must NOT connect_service) ---
  // The credential's refresh_token is still valid; calling connect_service
  // forces the user to re-auth a working credential — exactly the
  // regression the directive's transient branch is meant to prevent.

  const transientWronglyConnects = onTransient.toolCalls.find((c) => c.name === "connect_service");
  results.push({
    id: "connect-service-transient-no-spurious-connect",
    pass: !transientWronglyConnects,
    notes: [
      `connect_service called on transient failure: ${Boolean(transientWronglyConnects)}`,
      `tools called: ${onTransient.toolCalls.map((c) => c.name).join(", ") || "(none)"}`,
      `text[:300]: ${onTransient.text.slice(0, 300)}`,
      "Transient network/refresh errors leave the refresh_token intact — re-auth would be a regression.",
    ],
    metrics: { spuriousConnect: Boolean(transientWronglyConnects), systemPrompt: withDirective },
  });

  // Surface vocabulary: the supervisor should tell the user to retry, not
  // open a re-auth flow. Heuristic — accept any of "try again", "retry",
  // "moment", "temporarily" so we don't pin one exact phrasing.
  const transientSurfaceText = onTransient.text.toLowerCase();
  const transientSurfacesRetry =
    /try again|retry|moment|temporarily|transient|network|try in a/i.test(transientSurfaceText);
  results.push({
    id: "connect-service-transient-surfaces-retry-hint",
    pass: transientSurfacesRetry,
    notes: [
      `text suggests retry/wait/network: ${transientSurfacesRetry}`,
      `text[:300]: ${onTransient.text.slice(0, 300)}`,
      "On a transient blip the user-facing reply should orient toward retrying, not re-authenticating.",
    ],
    metrics: { surfacesRetry: transientSurfacesRetry, systemPrompt: withDirective },
  });

  // --- Dead-token scenarios (invalid_grant → connect_service IS correct) ---
  // Pairs with the transient case: same phase, different error text — the
  // supervisor must read the text and pick the right branch.

  const deadConnect = onDead.toolCalls.find(
    (c) => c.name === "connect_service" && String(c.input.provider) === PROVIDER,
  );
  results.push({
    id: "connect-service-dead-token-fires",
    pass: Boolean(deadConnect),
    notes: [
      `connect_service called on invalid_grant: ${Boolean(deadConnect)}`,
      `tools called: ${onDead.toolCalls.map((c) => c.name).join(", ") || "(none)"}`,
      `text[:300]: ${onDead.text.slice(0, 300)}`,
      "invalid_grant means the refresh_token is permanently dead — re-auth is the only path.",
    ],
    metrics: {
      called: Boolean(deadConnect),
      providerMatch: String(deadConnect?.input.provider) === PROVIDER,
      systemPrompt: withDirective,
    },
  });

  return results;
}

async function main() {
  await ensureCredentialsLoaded();
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.error("ANTHROPIC_API_KEY required — set it in ~/.atlas/.env or env.");
    Deno.exit(2);
  }

  const args = Deno.args;
  const jsonOutputIdx = args.indexOf("--json-output");
  const jsonOutputPath = jsonOutputIdx >= 0 ? args[jsonOutputIdx + 1] : undefined;
  const writeResult = args.includes("--write");

  const sha = await currentGitSha();
  const startedAt = new Date().toISOString();
  console.log(`▶ connect-service-on-auth-error eval @ ${sha}`);

  const results = await runEval();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n══ connect-service-on-auth-error summary: ${passed}/${results.length} passed ══`);
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id}`);
    for (const note of r.notes) console.log(`    ${note}`);
  }

  const report = { gitSha: sha, startedAt, passed, failed, results };
  if (writeResult || jsonOutputPath) {
    const path =
      jsonOutputPath ?? join(HARNESS_PATHS.resultsDir, `${sha}-connect-service-on-auth-error.json`);
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
    console.log(`\n→ ${path}`);
  }

  Deno.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
