#!/usr/bin/env -S deno run --allow-all

// deno-lint-ignore-file require-await
// AI SDK v6's `tool({ execute })` types the callback as returning a Promise,
// so the mock executes here are structurally `async` even though their bodies
// are pure synchronous fixture code. File-level disable keeps the per-callback
// surface clean; matches the convention in
// `tools/evals/agents/workspace-chat/bundled-agent-default.eval.ts`.

/**
 * Tool-choice prompt-tuning eval (in-process, no live daemon).
 *
 * Validates four tuning targets on the workspace-chat system prompt:
 *
 *   1. claude-code-overreach-pdf   — agent_claude-code is not picked for
 *      reading a PDF; the chat reaches for parse_artifact / get_artifact
 *      / run_code instead.
 *   2. claude-code-overreach-prose — agent_claude-code is not picked for
 *      "write me a marketing blurb"; direct prose answer is fine.
 *   3. save-artifact-preference    — save_artifact is preferred over
 *      write_file + create_artifact for inline LLM-authored content; the
 *      assistant follows up with display_artifact.
 *   4. mcp-describe-discipline     — when a workspace lists an MCP server
 *      in <mcp_servers> but no tool names are exposed, the chat calls
 *      list_mcp_tools / describe_mcp_tool before invoking gmail tools.
 *
 * Loads the real prompt.txt, the real agent_claude-code description, and
 * real tool descriptions from packages/system/agents/workspace-chat/tools/*.
 * Mock execute() callbacks capture tool-call sequences for assertion.
 *
 * Output: { results: [{ id, pass, notes, capturedTools }], … } so the
 * promptfoo provider can pick scenarios by id.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { jsonSchema, stepCountIs, streamText, tool } from "npm:ai@^6.0.177";
import dotenv from "npm:dotenv@^17.4.2";
import { z } from "npm:zod@^4.3.5";

// ────────────────────────────────────────────────────────────────────────
// Credential loading — dotenv first, then ~/.atlas/.env. Mirrors
// bundled-agent-default.eval.ts's pattern.
// ────────────────────────────────────────────────────────────────────────

dotenv.config();
const atlasEnv = join(process.env.HOME ?? "", ".atlas", ".env");
if (existsSync(atlasEnv)) dotenv.config({ path: atlasEnv, override: true });
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required (looked in env + ~/.atlas/.env)");
  Deno.exit(2);
}

const MODEL_NAME = process.env.EVAL_CHAT_MODEL ?? "claude-opus-4-7";

// Build the AI SDK Anthropic provider lazily — `ai` v6 lets us pass a model
// id string only when the registry knows it, otherwise we instantiate the
// provider directly.
const { createAnthropic } = await import("npm:@ai-sdk/anthropic@^3.0.76");
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ────────────────────────────────────────────────────────────────────────
// Source-of-truth content loaded from the live tree
// ────────────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname ?? ".", "../../../..");
const PROMPT_PATH = resolve(ROOT, "packages/system/agents/workspace-chat/prompt.txt");
const CLAUDE_CODE_AGENT_PATH = resolve(ROOT, "packages/bundled-agents/src/claude-code/agent.ts");

const WORKSPACE_CHAT_PROMPT = await readFile(PROMPT_PATH, "utf8");
const CLAUDE_CODE_AGENT_SRC = await readFile(CLAUDE_CODE_AGENT_PATH, "utf8");

/**
 * Pull the literal `description: "…"` string out of the bundled-agent
 * source so the eval always tests against the bytes shipped to the model.
 *
 * Whitespace-tolerant regex so a formatter change (line-length, single-line
 * vs wrapped) doesn't silently degrade fidelity. THROWS on miss — a stub
 * fallback would let `claude-code-overreach-*` scenarios report "pass"
 * while actually measuring whether the model rejects a placeholder, which
 * is worse than failing loudly.
 */
function extractClaudeCodeDescription(src: string): string {
  // `description:` (optional whitespace) `"…"` where the body may contain
  // escaped quotes. Non-greedy across the body via the [^"\\] / \\. class.
  const match = src.match(/description:\s*"((?:\\.|[^"\\])*)"/);
  if (!match?.[1]) {
    throw new Error(
      "[tool-choice.ts] could not extract claude-code description from agent.ts. " +
        "Source layout likely changed; update the regex. Stub fallback removed on purpose — " +
        "running the eval against a placeholder description is worse than failing here.",
    );
  }
  // Reverse the TS source-level escapes (\" → ", \n → newline) so the
  // extracted string matches the bytes the AI SDK ships to the model.
  return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
}

const CLAUDE_CODE_DESCRIPTION = extractClaudeCodeDescription(CLAUDE_CODE_AGENT_SRC);

// ────────────────────────────────────────────────────────────────────────
// Workspace + skills sections appended to the system prompt
// ────────────────────────────────────────────────────────────────────────

function workspaceSection(opts: { mcpServers?: Array<{ id: string; description: string }> }) {
  const mcp = opts.mcpServers
    ? `\n<mcp_servers>\n${opts.mcpServers
        .map((s) => `  <server id="${s.id}">${s.description}</server>`)
        .join("\n")}\n</mcp_servers>`
    : "";
  return `<workspace id="ws-eval" name="prompt-tuning-eval">
<description>Empty workspace used by the prompt-tuning eval.</description>${mcp}
</workspace>`;
}

const AVAILABLE_SKILLS_SECTION = `<available_skills>
<instruction>Load skills with load_skill when task matches.</instruction>
</available_skills>`;

function buildSystemPrompt(
  opts: { mcpServers?: Array<{ id: string; description: string }> } = {},
): string {
  return [WORKSPACE_CHAT_PROMPT, workspaceSection(opts), AVAILABLE_SKILLS_SECTION].join("\n\n");
}

// ────────────────────────────────────────────────────────────────────────
// Captured tool calls — shared state per scenario
// ────────────────────────────────────────────────────────────────────────

interface ToolCallCapture {
  name: string;
  input: unknown;
}

function makeCaptures() {
  return { calls: [] as ToolCallCapture[] };
}

type Captures = ReturnType<typeof makeCaptures>;

function record(captures: Captures, name: string, input: unknown) {
  captures.calls.push({ name, input });
}

// ────────────────────────────────────────────────────────────────────────
// Mock tool catalog — real descriptions copied verbatim from source.
// Bodies just record + return synthetic success so the model can chain.
// ────────────────────────────────────────────────────────────────────────

const ARTIFACT_ID = "art_eval_0001";

// Hoisted Zod schemas — `ai`'s `tool()` overload narrows INPUT to `never`
// when given an inline `z.object(...)` (Zod v4 + AI SDK v6 quirk). Pulling
// each schema to a top-level const sidesteps it. Matches the pattern in
// `tools/evals/agents/workspace-chat/bundled-agent-default.eval.ts`.

const ArtifactIdInputSchema = z.object({ artifactId: z.string() });
const ClaudeCodeInputSchema = z.object({
  prompt: z.string().describe("Task description for the code agent"),
});
const SaveArtifactInputSchema = z.object({
  filename: z.string(),
  content: z.string(),
  title: z.string(),
  summary: z.string(),
});
const CreateArtifactInputSchema = z.object({
  path: z.string(),
  title: z.string(),
  summary: z.string(),
});
const WriteFileInputSchema = z.object({ path: z.string(), content: z.string() });
const ReadFileInputSchema = z.object({ path: z.string() });
const RunCodeInputSchema = z.object({
  language: z.enum(["python", "javascript", "bash"]),
  code: z.string(),
});
const WebFetchInputSchema = z.object({ url: z.string() });
const WebSearchInputSchema = z.object({ query: z.string() });
const DelegateInputSchema = jsonSchema<{ prompt: string; mcpServers?: string[] }>({
  type: "object",
  properties: {
    prompt: { type: "string" },
    mcpServers: { type: "array", items: { type: "string" } },
  },
  required: ["prompt"],
});
const ListMcpToolsInputSchema = z.object({ serverId: z.string() });
const DescribeMcpToolInputSchema = z.object({ serverId: z.string(), toolName: z.string() });

function buildTools(captures: Captures) {
  // The real bundled-agent surfaces this as `agent_claude-code` (hyphen).
  // The Anthropic API tool-name regex is /^[a-zA-Z0-9_-]{1,64}$/, so hyphens
  // are legal. We use the hyphenated name as the JS object key (any string
  // works) so the model sees the same name a live workspace-chat session
  // would expose. Returned inline so TypeScript infers each tool's precise
  // INPUT shape — a `Record<string, ReturnType<typeof tool>>` cast collapses
  // every entry to `Tool<never, never>` and breaks the AI SDK overload.
  return {
    parse_artifact: tool({
      description:
        "Extract text from a binary artifact (PDF, DOCX, or PPTX) as markdown. Use whenever you need the *contents* of a binary artifact for reasoning. Returns `{ markdown, mimeType, filename }`.",
      inputSchema: ArtifactIdInputSchema,
      execute: async ({ artifactId }: z.infer<typeof ArtifactIdInputSchema>) => {
        record(captures, "parse_artifact", { artifactId });
        return {
          markdown: "# (mock) PDF body\n\nKey points: foo, bar, baz.",
          mimeType: "application/pdf",
          filename: "mock.pdf",
        };
      },
    }),
    "agent_claude-code": tool({
      description: CLAUDE_CODE_DESCRIPTION,
      inputSchema: ClaudeCodeInputSchema,
      execute: async ({ prompt }: z.infer<typeof ClaudeCodeInputSchema>) => {
        record(captures, "agent_claude-code", { prompt });
        return { success: true, summary: "(mock) code agent finished" };
      },
    }),
    get_artifact: tool({
      description:
        "Get artifact by ID. For binary artifacts (PDF/image/etc.), use the returned `hint` to choose the right follow-up tool; the response will not include raw bytes.",
      inputSchema: ArtifactIdInputSchema,
      execute: async ({ artifactId }: z.infer<typeof ArtifactIdInputSchema>) => {
        record(captures, "get_artifact", { artifactId });
        return {
          id: artifactId,
          mimeType: "application/pdf",
          hint: "Use parse_artifact for PDF/DOCX/PPTX contents.",
        };
      },
    }),
    display_artifact: tool({
      description:
        "Display an artifact to the user. Only use artifact IDs from tool responses. Never invent IDs.",
      inputSchema: ArtifactIdInputSchema,
      execute: async ({ artifactId }: z.infer<typeof ArtifactIdInputSchema>) => {
        record(captures, "display_artifact", { artifactId });
        return { success: true, artifactId };
      },
    }),
    save_artifact: tool({
      description:
        "Register inline UTF-8 text content as a displayable artifact in one call. Preferred over write_file → create_artifact whenever you already have the content as a string (markdown, JSON, code, prose, CSV). Binary content must go through run_code + create_artifact — filenames implying binary MIME (.png, .pdf, .zip, etc.) are rejected. Immediately call display_artifact with the returned `id`.",
      inputSchema: SaveArtifactInputSchema,
      execute: async (input: z.infer<typeof SaveArtifactInputSchema>) => {
        record(captures, "save_artifact", input);
        return { success: true, id: ARTIFACT_ID, type: "file", summary: input.summary };
      },
    }),
    create_artifact: tool({
      description:
        "Register a file already written to the scratch directory (by run_code or write_file) as a displayable artifact. For inline LLM-authored text content prefer save_artifact — it skips the write_file round-trip. After registering, immediately call display_artifact with the returned `id`.",
      inputSchema: CreateArtifactInputSchema,
      execute: async (input: z.infer<typeof CreateArtifactInputSchema>) => {
        record(captures, "create_artifact", input);
        return { success: true, id: ARTIFACT_ID, type: "file", summary: input.summary };
      },
    }),
    write_file: tool({
      description:
        "Write UTF-8 text to a file in the session scratch directory. Overwrites any existing file at the same path. Use this to stage intermediate data for a later `run_code` call or to save the LLM's generated content for the user to retrieve.",
      inputSchema: WriteFileInputSchema,
      execute: async (input: z.infer<typeof WriteFileInputSchema>) => {
        record(captures, "write_file", input);
        return { ok: true, path: input.path, bytes_written: input.content.length };
      },
    }),
    read_file: tool({
      description:
        "Read a text file from the session scratch directory. Scoped to the per-session ephemeral dir — paths are relative, absolute paths and `..` escapes are rejected.",
      inputSchema: ReadFileInputSchema,
      execute: async ({ path }: z.infer<typeof ReadFileInputSchema>) => {
        record(captures, "read_file", { path });
        return { path, content: "(mock contents)", size_bytes: 16, truncated: false };
      },
    }),
    run_code: tool({
      description:
        "Execute a short Python/JavaScript/bash script in an ephemeral per-session scratch dir. Files persist across calls within the session. Use for one-off scripts, parsing files at known paths, calling localhost endpoints, or quick computations.",
      inputSchema: RunCodeInputSchema,
      execute: async (input: z.infer<typeof RunCodeInputSchema>) => {
        record(captures, "run_code", input);
        return { stdout: "(mock stdout)", stderr: "", exit_code: 0 };
      },
    }),
    web_fetch: tool({
      description:
        "Fetch a public URL and return its body as markdown. Public internet only — localhost / internal endpoints must go through run_code with bash.",
      inputSchema: WebFetchInputSchema,
      execute: async ({ url }: z.infer<typeof WebFetchInputSchema>) => {
        record(captures, "web_fetch", { url });
        return { url, markdown: "(mock page body)" };
      },
    }),
    web_search: tool({
      description: "Search the public web. Returns ranked { title, url, description } triples.",
      inputSchema: WebSearchInputSchema,
      execute: async ({ query }: z.infer<typeof WebSearchInputSchema>) => {
        record(captures, "web_search", { query });
        return { results: [] };
      },
    }),
    delegate: tool({
      description:
        "Delegate a sub-task to a general LLM helper. Pass `mcpServers: [server-id]` to give the helper access to a wired MCP server's tools. Use for general sub-tasks when no direct tool or bundled agent fits.",
      inputSchema: DelegateInputSchema,
      execute: async (input: { prompt: string; mcpServers?: string[] }) => {
        record(captures, "delegate", input);
        return { success: true, summary: "(mock) delegate finished" };
      },
    }),
    list_mcp_tools: tool({
      description:
        "Spin up an MCP server and list the tool names, descriptions, and input schemas it exposes. Use this before writing agent code or workspace config that references MCP tools — inputSchema shows the exact parameter names and types to pass.",
      inputSchema: ListMcpToolsInputSchema,
      execute: async ({ serverId }: z.infer<typeof ListMcpToolsInputSchema>) => {
        record(captures, "list_mcp_tools", { serverId });
        return {
          ok: true,
          tools: [
            {
              name: `${serverId}/search_messages`,
              description: "Search messages in the connected account.",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
        };
      },
    }),
    describe_mcp_tool: tool({
      description:
        "Return name + description + inputSchema for a single MCP tool on a given server. Cheaper than list_mcp_tools when you already know which tool you're after.",
      inputSchema: DescribeMcpToolInputSchema,
      execute: async ({ serverId, toolName }: z.infer<typeof DescribeMcpToolInputSchema>) => {
        record(captures, "describe_mcp_tool", { serverId, toolName });
        return {
          ok: true,
          tool: {
            name: `${serverId}/${toolName}`,
            description: "(mock) tool description",
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
          },
        };
      },
    }),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Scenario runner
// ────────────────────────────────────────────────────────────────────────

interface ScenarioOutcome {
  id: string;
  pass: boolean;
  notes: string[];
  capturedTools: string[];
  systemPrompt: string;
  userMessage: string;
  assistantText: string;
}

interface Scenario {
  id: string;
  userMessage: string;
  systemPromptOpts?: { mcpServers?: Array<{ id: string; description: string }> };
  check: (captures: Captures) => { pass: boolean; notes: string[] };
}

const SCENARIOS: Scenario[] = [
  {
    id: "claude-code-overreach-pdf",
    userMessage:
      "I just uploaded a PDF — artifact id `art_pdf_001`. Read it and summarize in 3 bullets.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const usedCodeAgent = names.includes("agent_claude-code");
      const usedReadingTool = ["parse_artifact", "get_artifact", "run_code"].some((t) =>
        names.includes(t),
      );
      const notes: string[] = [];
      if (usedCodeAgent) notes.push("called agent_claude-code (should not for a PDF read).");
      if (!usedReadingTool) {
        notes.push("did not call parse_artifact / get_artifact / run_code; expected at least one.");
      }
      return { pass: !usedCodeAgent && usedReadingTool, notes };
    },
  },
  {
    id: "claude-code-overreach-prose",
    userMessage: "Write me a 3-paragraph marketing blurb about a new espresso machine.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const usedCodeAgent = names.includes("agent_claude-code");
      const notes: string[] = [];
      if (usedCodeAgent) notes.push("called agent_claude-code (should not for prose writing).");
      return { pass: !usedCodeAgent, notes };
    },
  },
  {
    id: "save-artifact-preference",
    userMessage: [
      "Save this as an artifact and show it to me:",
      "",
      "# Daily Standup",
      "",
      "- Shipped PR 1234",
      "- Reviewed PR 1235",
      "- Investigating flaky test in foo.spec.ts",
    ].join("\n"),
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const usedSave = names.includes("save_artifact");
      const usedWriteFile = c.calls.some((call) => {
        if (call.name !== "write_file") return false;
        const content = (call.input as { content?: unknown } | undefined)?.content;
        return typeof content === "string" && content.includes("Daily Standup");
      });
      const usedDisplay = names.includes("display_artifact");
      // display_artifact must come after the save call so the model is
      // surfacing the right id.
      const saveIdx = names.indexOf("save_artifact");
      const displayIdx = names.indexOf("display_artifact");
      const displayAfterSave = saveIdx >= 0 && displayIdx > saveIdx;
      const notes: string[] = [];
      if (!usedSave) notes.push("save_artifact not called.");
      if (usedWriteFile)
        notes.push("write_file used to stage the content (should use save_artifact).");
      if (!usedDisplay) notes.push("display_artifact not called.");
      if (usedSave && usedDisplay && !displayAfterSave) {
        notes.push("display_artifact called before save_artifact.");
      }
      return { pass: usedSave && !usedWriteFile && usedDisplay && displayAfterSave, notes };
    },
  },
  {
    id: "claude-code-overreach-url-fetch",
    userMessage:
      "Fetch https://news.ycombinator.com/news and tell me the top story's title and points.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const usedCodeAgent = names.includes("agent_claude-code");
      const usedLighterTool = ["web_fetch", "web_search", "agent_web"].some((t) =>
        names.includes(t),
      );
      const notes: string[] = [];
      if (usedCodeAgent) notes.push("called agent_claude-code (should not for a URL fetch).");
      if (!usedLighterTool) {
        notes.push("did not call web_fetch / web_search / agent_web; expected one of them.");
      }
      return { pass: !usedCodeAgent && usedLighterTool, notes };
    },
  },
  {
    id: "claude-code-overreach-one-off-script",
    userMessage:
      "Compute the SHA-256 of the string 'hello world' and give me the hex digest. Use run_code if you need to.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const usedCodeAgent = names.includes("agent_claude-code");
      const notes: string[] = [];
      if (usedCodeAgent) {
        notes.push("called agent_claude-code (should not for a one-line hash computation).");
      }
      return { pass: !usedCodeAgent, notes };
    },
  },
  {
    id: "claude-code-overreach-docx-parse",
    userMessage:
      "I uploaded a meeting recap as DOCX — artifact id `art_doc_002`. Pull out the action items into a numbered list.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const usedCodeAgent = names.includes("agent_claude-code");
      const usedReadingTool = ["parse_artifact", "get_artifact"].some((t) => names.includes(t));
      const notes: string[] = [];
      if (usedCodeAgent) notes.push("called agent_claude-code (should not for DOCX parsing).");
      if (!usedReadingTool) {
        notes.push("did not call parse_artifact / get_artifact; expected one of them.");
      }
      return { pass: !usedCodeAgent && usedReadingTool, notes };
    },
  },
  {
    id: "claude-code-legit-multi-file-refactor",
    userMessage: [
      "The repo `payments-service` is already checked out at `/tmp/payments-service`.",
      "It has ~40 Express route handlers in src/api/ that each call `validateSession(req)`",
      "manually. Refactor every handler to use a new middleware `requireSession` defined",
      "in src/middleware/auth.ts. Update the affected unit tests, run `pnpm test`, and",
      "commit the changes on a new branch `refactor/centralize-session-validation`.",
      "I just need this done — no need to ask me anything, the path and task are everything you need.",
    ].join(" "),
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const usedCodeAgent = names.includes("agent_claude-code");
      const notes: string[] = [];
      if (!usedCodeAgent) {
        notes.push(
          "did not call agent_claude-code; this is exactly the heavyweight multi-file refactor it exists for.",
        );
      }
      return { pass: usedCodeAgent, notes };
    },
  },
  {
    id: "save-artifact-json-config",
    userMessage: [
      "Save this as a JSON artifact called `eslint.config.json` and show it to me:",
      "",
      '{ "extends": "@friday/eslint-config", "rules": { "no-console": "warn" } }',
    ].join("\n"),
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const usedSave = names.includes("save_artifact");
      const usedWriteFile = names.includes("write_file");
      const usedDisplay = names.includes("display_artifact");
      const notes: string[] = [];
      if (!usedSave) notes.push("save_artifact not called for inline JSON.");
      if (usedWriteFile) notes.push("write_file used (should be one-step save_artifact).");
      if (!usedDisplay) notes.push("display_artifact not called.");
      return { pass: usedSave && !usedWriteFile && usedDisplay, notes };
    },
  },
  {
    id: "save-artifact-csv-table",
    userMessage:
      "Generate 5 rows of fake user data (name,email,signup_date) as CSV and save it as a downloadable artifact.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const usedSave = names.includes("save_artifact");
      const usedDisplay = names.includes("display_artifact");
      // The model should emit the CSV directly via save_artifact — it's
      // small, text-only, model-authored. The failure mode we're guarding
      // against is BOTH the write_file → create_artifact two-step AND the
      // unnecessary run_code escape hatch (which previously made this case
      // a near-tautology).
      const usedWriteFile = names.includes("write_file");
      const usedRunCode = names.includes("run_code");
      const notes: string[] = [];
      if (!usedSave) notes.push("save_artifact not called for inline CSV.");
      if (usedWriteFile) notes.push("write_file used (should be one-step save_artifact).");
      if (usedRunCode) {
        notes.push(
          "run_code used for trivially-authored CSV (model should emit directly via save_artifact).",
        );
      }
      if (!usedDisplay) notes.push("display_artifact not called.");
      return { pass: usedSave && !usedWriteFile && !usedRunCode && usedDisplay, notes };
    },
  },
  {
    id: "create-artifact-binary-counter",
    userMessage:
      "Use Python to draw a 200x200 PNG with a single red circle on a white background and show it to me. Use matplotlib or Pillow.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      // Binary content can't be a `save_artifact` string — the model must
      // produce the file via run_code and register it with create_artifact.
      const ranCode = names.includes("run_code");
      const usedCreate = names.includes("create_artifact");
      const usedSave = c.calls.some(
        (call) =>
          call.name === "save_artifact" &&
          typeof (call.input as { filename?: string }).filename === "string" &&
          ((call.input as { filename: string }).filename.endsWith(".png") ||
            (call.input as { filename: string }).filename.endsWith(".jpg")),
      );
      const notes: string[] = [];
      if (!ranCode) notes.push("run_code not called; expected to generate the PNG.");
      if (!usedCreate) {
        notes.push(
          "create_artifact not called; binary outputs go through file-based registration.",
        );
      }
      if (usedSave) {
        notes.push(
          "save_artifact used for binary content (must be create_artifact + scratch file).",
        );
      }
      return { pass: ranCode && usedCreate && !usedSave, notes };
    },
  },
  {
    id: "mcp-describe-discipline",
    systemPromptOpts: {
      mcpServers: [
        {
          id: "gmail-mcp",
          description: "Gmail MCP server — search, read, send email on the user's account.",
        },
      ],
    },
    userMessage:
      "Search my Gmail for emails from sarah@example.com in the last 7 days and list the subjects.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const discoveryIdx = names.findIndex(
        (n) => n === "list_mcp_tools" || n === "describe_mcp_tool",
      );
      const invokeIdx = names.findIndex(
        (n) =>
          n === "delegate" ||
          n.startsWith("agent_") ||
          // Hallucinated tool names — record() captures these too because
          // the model would have to call one of our registered tools.
          // If the model emits an unknown tool the AI SDK rejects it and
          // the call never reaches execute, so the absence of any gmail-
          // shaped call is itself a "no fabrication" signal.
          n === "gmail_search" ||
          n === "search_emails",
      );
      const discoveryFirst = discoveryIdx >= 0 && (invokeIdx < 0 || discoveryIdx < invokeIdx);
      const notes: string[] = [];
      if (discoveryIdx < 0) {
        notes.push("neither list_mcp_tools nor describe_mcp_tool was called.");
      }
      if (invokeIdx >= 0 && discoveryIdx >= 0 && invokeIdx < discoveryIdx) {
        notes.push(
          `${names[invokeIdx]} called before MCP discovery (expected list/describe first).`,
        );
      }
      return { pass: discoveryFirst, notes };
    },
  },
  {
    id: "mcp-no-fabricated-tool-names",
    systemPromptOpts: {
      mcpServers: [
        {
          id: "gmail-mcp",
          description: "Gmail MCP server — search, read, send email on the user's account.",
        },
      ],
    },
    userMessage:
      "Use the gmail-mcp tool `gmail_get_thread` to fetch thread `abc123` and show the body of the latest message.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const discoveryUsed = names.includes("list_mcp_tools") || names.includes("describe_mcp_tool");
      // A direct, name-it-and-call-it path goes via `delegate` (with the
      // mcpServers parameter naming gmail-mcp) only AFTER discovery. The
      // failure mode is delegating to gmail-mcp without verifying the tool
      // name first.
      const delegateIdx = names.indexOf("delegate");
      const discoveryIdx = names.findIndex(
        (n) => n === "list_mcp_tools" || n === "describe_mcp_tool",
      );
      const delegateBeforeDiscover =
        delegateIdx >= 0 && (discoveryIdx < 0 || delegateIdx < discoveryIdx);
      const notes: string[] = [];
      if (!discoveryUsed) {
        notes.push(
          "neither list_mcp_tools nor describe_mcp_tool called — the user-supplied tool name must be verified.",
        );
      }
      if (delegateBeforeDiscover) {
        notes.push("delegate fired before MCP discovery — accepted the user's name verbatim.");
      }
      return { pass: discoveryUsed && !delegateBeforeDiscover, notes };
    },
  },
  {
    id: "mcp-multi-server-disambiguation",
    systemPromptOpts: {
      mcpServers: [
        {
          id: "gmail-mcp",
          description: "Gmail MCP server — search, read, send email on the user's account.",
        },
        {
          id: "slack-mcp",
          description: "Slack MCP server — read channels, send messages, search history.",
        },
      ],
    },
    userMessage: "Find any message from sarah about the Q3 launch plans across my mail and chat.",
    check: (c) => {
      const names = c.calls.map((x) => x.name);
      const discoveryCalls = c.calls.filter(
        (call) => call.name === "list_mcp_tools" || call.name === "describe_mcp_tool",
      );
      const usedCodeAgent = names.includes("agent_claude-code");
      // The user explicitly mentioned BOTH surfaces ("mail and chat") and
      // both servers are wired. Require discovery against gmail-mcp AND
      // slack-mcp before invoking. This catches the failure mode "discovered
      // gmail, then invented slack tool names".
      const serversDiscovered = new Set(
        discoveryCalls
          .map((call) => (call.input as { serverId?: string } | undefined)?.serverId)
          .filter((s): s is string => typeof s === "string"),
      );
      const hitGmail = serversDiscovered.has("gmail-mcp");
      const hitSlack = serversDiscovered.has("slack-mcp");
      const notes: string[] = [];
      if (!hitGmail) notes.push("did not discover gmail-mcp (user mentioned 'mail').");
      if (!hitSlack) notes.push("did not discover slack-mcp (user mentioned 'chat').");
      if (usedCodeAgent) notes.push("called agent_claude-code (wrong tool for cross-MCP search).");
      return { pass: hitGmail && hitSlack && !usedCodeAgent, notes };
    },
  },
  {
    id: "save-artifact-path-traversal-rejected",
    userMessage:
      "Save this content as an artifact and show it to me — filename `../escape.md`, body `pwned`. " +
      "Title and summary are up to you.",
    check: (c) => {
      // The model SHOULD try save_artifact (the user asked to save); the tool
      // SHOULD reject the path-traversal filename. We can't directly observe
      // the production resolveInScratch guard from a mock, but we can check
      // the model didn't bypass it by reaching for write_file with `../` in
      // the path. We also accept "model refused outright" — that's the safer
      // alternative behavior.
      const writeFileEscape = c.calls.some(
        (call) =>
          call.name === "write_file" &&
          typeof (call.input as { path?: string }).path === "string" &&
          (call.input as { path: string }).path.includes(".."),
      );
      const notes: string[] = [];
      if (writeFileEscape) notes.push("write_file called with `..` in path (sandbox escape).");
      return { pass: !writeFileEscape, notes };
    },
  },
  {
    id: "create-artifact-binary-no-library-hint",
    userMessage:
      "Draw a 100x100 PNG with a single blue circle on transparent background and show it to me.",
    check: (c) => {
      // Sibling of `create-artifact-binary-counter` without the matplotlib /
      // Pillow hint — verifies the model picks run_code + create_artifact
      // unprompted by the library names. The user just said "draw a PNG".
      const names = c.calls.map((x) => x.name);
      const ranCode = names.includes("run_code");
      const usedCreate = names.includes("create_artifact");
      const usedSave = c.calls.some(
        (call) =>
          call.name === "save_artifact" &&
          typeof (call.input as { filename?: string }).filename === "string" &&
          ((call.input as { filename: string }).filename.endsWith(".png") ||
            (call.input as { filename: string }).filename.endsWith(".jpg")),
      );
      const notes: string[] = [];
      if (!ranCode) notes.push("run_code not called; expected to generate the PNG.");
      if (!usedCreate)
        notes.push(
          "create_artifact not called; binary outputs go through file-based registration.",
        );
      if (usedSave) notes.push("save_artifact used for binary content (must be create_artifact).");
      return { pass: ranCode && usedCreate && !usedSave, notes };
    },
  },
];

async function runScenario(scenario: Scenario): Promise<ScenarioOutcome> {
  const captures = makeCaptures();
  const tools = buildTools(captures);
  const systemPrompt = buildSystemPrompt(scenario.systemPromptOpts ?? {});

  // temperature: 0 is the standard determinism knob for evals. The AI SDK
  // emits a warning + ignores it for reasoning-class models like
  // claude-opus-4-X (they sample via internal thinking, not temp); we
  // skip the field on those so the eval log isn't drowned in warnings.
  // For temp-supporting models (Sonnet 4.x, Haiku 4.5, …) it pins
  // outcomes scenario-by-scenario across runs.
  const supportsTemperature = !/opus-4-/.test(MODEL_NAME);
  const result = streamText({
    model: anthropic(MODEL_NAME),
    system: systemPrompt,
    ...(supportsTemperature ? { temperature: 0 } : {}),
    messages: [{ role: "user", content: scenario.userMessage }],
    tools,
    // 8 steps is generous enough for the multi-server MCP cases
    // (list_mcp_tools × 2 + describe_mcp_tool × 1 + delegate × 2 with
    // explanatory text between them) without inviting unbounded retries.
    stopWhen: stepCountIs(8),
  });

  // Drain. Collect assistant text deltas for diagnostic visibility.
  let assistantText = "";
  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta") {
      assistantText += (chunk as { text?: string }).text ?? "";
    }
  }

  const { pass, notes } = scenario.check(captures);
  return {
    id: scenario.id,
    pass,
    notes,
    capturedTools: captures.calls.map((c) => c.name),
    systemPrompt,
    userMessage: scenario.userMessage,
    assistantText: assistantText.trim(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────────

function parseArgs(): { jsonOutput?: string; scenarioId?: string } {
  const args = Deno.args;
  const out: { jsonOutput?: string; scenarioId?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json-output") out.jsonOutput = args[++i];
    else if (args[i] === "--scenario") out.scenarioId = args[++i];
  }
  return out;
}

async function main() {
  const { jsonOutput, scenarioId } = parseArgs();
  const targets = scenarioId ? SCENARIOS.filter((s) => s.id === scenarioId) : SCENARIOS;
  if (scenarioId && targets.length === 0) {
    console.error(`unknown scenario: ${scenarioId}`);
    Deno.exit(2);
  }

  console.log(`▶ tool-choice prompt-tuning eval (model=${MODEL_NAME})`);
  const results: ScenarioOutcome[] = [];
  for (const scenario of targets) {
    console.log(`\n── ${scenario.id} ──`);
    try {
      const outcome = await runScenario(scenario);
      results.push(outcome);
      console.log(`${outcome.pass ? "✓" : "✗"} ${outcome.id}`);
      console.log(`    tools: [${outcome.capturedTools.join(", ") || "(none)"}]`);
      for (const note of outcome.notes) console.log(`    note: ${note}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        id: scenario.id,
        pass: false,
        notes: [`scenario threw: ${message}`],
        capturedTools: [],
        systemPrompt: buildSystemPrompt(scenario.systemPromptOpts ?? {}),
        userMessage: scenario.userMessage,
        assistantText: "",
      });
      console.log(`✗ ${scenario.id} (threw: ${message})`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n══ summary: ${passed}/${results.length} passed ══`);

  const report = {
    model: MODEL_NAME,
    startedAt: new Date().toISOString(),
    passed,
    failed: results.length - passed,
    results,
  };
  if (jsonOutput) {
    await Deno.mkdir(dirname(jsonOutput), { recursive: true });
    await Deno.writeTextFile(jsonOutput, JSON.stringify(report, null, 2));
    console.log(`→ ${jsonOutput}`);
  }

  Deno.exit(report.failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
