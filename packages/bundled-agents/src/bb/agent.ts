import { execFile } from "node:child_process";
import { rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createAgent, err, ok } from "@atlas/agent-sdk";
import { createBitbucketCloudClient } from "@coderabbitai/bitbucket/cloud";
import { z } from "zod";
import { parseOperationConfig as parseOpConfig } from "../shared/operation-parser.ts";
import {
  buildCommentBody,
  buildFailedFindingsSummary,
  type Finding,
  FindingSchema,
} from "../vcs/schemas.ts";

const execFileAsync = promisify(execFile);

/**
 * Output schema for bb agent operations.
 */
export const BbOutputSchema = z.object({
  operation: z.string().describe("The operation that was executed"),
  success: z.boolean().describe("Whether the operation succeeded"),
  data: z.object({}).catchall(z.unknown()).describe("Operation-specific output data"),
});

export type BbOutput = z.infer<typeof BbOutputSchema>;

/**
 * Parse a Bitbucket PR URL into its components using URL parsing.
 *
 * Accepts: https://bitbucket.org/workspace/repo/pull-requests/123
 * Returns: { workspace, repo_slug, pr_id }
 */
export function parsePrUrl(prUrl: string): { workspace: string; repo_slug: string; pr_id: number } {
  const url = new URL(prUrl);
  if (url.hostname !== "bitbucket.org") {
    throw new Error(`Expected bitbucket.org URL, got: ${url.hostname}`);
  }

  // pathname: /workspace/repo/pull-requests/123
  const segments = url.pathname.split("/").filter(Boolean);
  const workspace = segments[0];
  const repo_slug = segments[1];
  const pullSegment = segments[2];
  const prIdStr = segments[3];

  if (!workspace || !repo_slug || pullSegment !== "pull-requests" || !prIdStr) {
    throw new Error(
      `Invalid PR URL path: ${url.pathname}. Expected: /workspace/repo/pull-requests/123`,
    );
  }

  const pr_id = parseInt(prIdStr, 10);
  if (Number.isNaN(pr_id)) {
    throw new Error(`Invalid PR number in URL: ${prIdStr}`);
  }

  return { workspace, repo_slug, pr_id };
}

/**
 * Parse a Bitbucket repository URL into workspace and repo_slug.
 *
 * Accepts: https://bitbucket.org/workspace/repo[/src/main/...]
 * Returns: { workspace, repo_slug }
 */
export function parseRepoUrl(repoUrl: string): { workspace: string; repo_slug: string } {
  const url = new URL(repoUrl);
  if (url.hostname !== "bitbucket.org") {
    throw new Error(`Expected bitbucket.org URL, got: ${url.hostname}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const workspace = segments[0];
  const repo_slug = segments[1];

  if (!workspace || !repo_slug) {
    throw new Error(`Invalid repo URL path: ${url.pathname}. Expected: /workspace/repo`);
  }

  return { workspace, repo_slug };
}

/**
 * Schemas for individual operations parsed from the prompt's JSON config.
 *
 * All PR operations accept `pr_url` directly — the agent parses
 * workspace/repo/pr_id internally via URL parsing.
 */
const CloneConfigSchema = z.object({ operation: z.literal("clone"), pr_url: z.url() });

const PrViewConfigSchema = z.object({
  operation: z.literal("pr-view"),
  pr_url: z.url(),
  fields: z.array(z.string()).optional(),
});

const PrDiffConfigSchema = z.object({
  operation: z.literal("pr-diff"),
  pr_url: z.url(),
  name_only: z.boolean().optional(),
});

const PrReviewConfigSchema = z.object({
  operation: z.literal("pr-review"),
  pr_url: z.url(),
  body: z.string(),
});

const PrFilesConfigSchema = z.object({ operation: z.literal("pr-files"), pr_url: z.url() });

const PrInlineReviewConfigSchema = z.object({
  operation: z.literal("pr-inline-review"),
  pr_url: z.url(),
  commit_id: z.string().optional(),
  verdict: z.string(),
  summary: z.string(),
  findings: z.array(FindingSchema),
});

const PrReadThreadsConfigSchema = z.object({
  operation: z.literal("pr-read-threads"),
  pr_url: z.url(),
});

const PrPostFollowupConfigSchema = z.object({
  operation: z.literal("pr-post-followup"),
  pr_url: z.url(),
  commit_id: z.string().optional(),
  thread_replies: z.array(z.object({ comment_id: z.number(), body: z.string() })),
  new_findings: z.array(FindingSchema),
  summary: z.string(),
});

const RepoCloneConfigSchema = z.object({
  operation: z.literal("repo-clone"),
  /** Repository URL: https://bitbucket.org/workspace/repo */
  repo_url: z.url(),
  /** Branch to check out after cloning (defaults to default branch). */
  branch: z.string().optional(),
});

const RepoPushConfigSchema = z.object({
  operation: z.literal("repo-push"),
  /** Local path to the cloned repository. */
  path: z.string(),
  /** Branch name to push. */
  branch: z.string(),
  /** Repository URL (used to authenticate the push). */
  repo_url: z.url(),
});

const PrCreateConfigSchema = z.object({
  operation: z.literal("pr-create"),
  /** Repository URL: https://bitbucket.org/workspace/repo */
  repo_url: z.url(),
  /** Source branch name (the feature branch). */
  source_branch: z.string(),
  /** Destination branch name (defaults to "main"). */
  destination_branch: z.string().optional(),
  /** Pull request title. */
  title: z.string(),
  /** Free-form description. If provided, used as-is (after sanitization).
   *  If omitted, the agent builds a description from the structured fields below. */
  description: z.string().optional(),
  /** Issue key (e.g. DEV-4) — used to build "Fixes DEV-4" header when no description provided. */
  issue_key: z.string().optional(),
  /** Summary of the change — used in the auto-built description body. */
  summary: z.string().optional(),
  /** List of changed files — rendered as a bullet list in the auto-built description. */
  files_changed: z.array(z.string()).optional(),
  /** Whether to close the source branch after merge. */
  close_source_branch: z.boolean().optional(),
});

const OperationConfigSchema = z.discriminatedUnion("operation", [
  CloneConfigSchema,
  RepoCloneConfigSchema,
  RepoPushConfigSchema,
  PrViewConfigSchema,
  PrDiffConfigSchema,
  PrReviewConfigSchema,
  PrFilesConfigSchema,
  PrInlineReviewConfigSchema,
  PrReadThreadsConfigSchema,
  PrPostFollowupConfigSchema,
  PrCreateConfigSchema,
]);

type OperationConfig = z.infer<typeof OperationConfigSchema>;

/**
 * Zod schema for Bitbucket PR comment API responses.
 *
 * The OpenAPI-generated types use `Readonly<Record<string, unknown>>` intersections
 * that make property access return `unknown`. We parse through Zod instead.
 */
const BbCommentSchema = z.object({
  id: z.number().optional(),
  content: z.object({ raw: z.string().optional() }).optional(),
  inline: z
    .object({ path: z.string().optional(), from: z.number().nullish(), to: z.number().nullish() })
    .nullish(),
  parent: z.object({ id: z.number().optional() }).optional(),
  user: z.object({ uuid: z.string().optional() }).optional(),
  created_on: z.string().optional(),
});

type BbComment = z.infer<typeof BbCommentSchema>;

const BbPaginatedCommentsSchema = z.object({
  next: z.string().optional(),
  values: z.array(BbCommentSchema).optional(),
});

/** Zod schema for Bitbucket diffstat API responses. */
const BbDiffstatEntrySchema = z.object({
  new: z.object({ path: z.string().optional() }).optional(),
  old: z.object({ path: z.string().optional() }).optional(),
  status: z.string().optional(),
});

const BbPaginatedDiffstatSchema = z.object({
  next: z.string().optional(),
  values: z.array(BbDiffstatEntrySchema).optional(),
});

/**
 * Parse the operation config from the prompt string.
 *
 * Delegates to the shared operation parser which handles code fences,
 * balanced-brace raw JSON extraction, and full-prompt fallback.
 */
export function parseOperationConfig(prompt: string): OperationConfig {
  return parseOpConfig(prompt, OperationConfigSchema);
}

/**
 * Execute a git command. Redacts credentials from any error messages.
 */
async function git(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
  redact?: string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
    });
    return stdout.trim();
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of redact ?? []) {
      if (secret) message = message.replaceAll(secret, "***");
    }
    throw new Error(message);
  }
}

/**
 * Create a typed Bitbucket Cloud API client.
 * Used for endpoints with simple response types (PR view, user).
 */
function createClient(username: string, token: string) {
  return createBitbucketCloudClient({
    baseUrl: "https://api.bitbucket.org/2.0",
    headers: { Accept: "application/json", Authorization: `Basic ${btoa(`${username}:${token}`)}` },
  });
}

/** Build Basic auth header value. */
function basicAuth(username: string, token: string): string {
  return `Basic ${btoa(`${username}:${token}`)}`;
}

/**
 * Raw fetch with Basic auth. Returns response text.
 * Follows 302 redirects automatically.
 */
async function fetchRaw(url: string, username: string, token: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Authorization: basicAuth(username, token) },
    redirect: "follow",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Bitbucket API error: ${response.status} ${response.statusText} — ${body}`);
  }
  return response.text();
}

/**
 * POST JSON to a Bitbucket API endpoint. Returns parsed response body.
 */
async function postJson(
  url: string,
  body: Record<string, unknown>,
  username: string,
  token: string,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuth(username, token),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Bitbucket API error: ${response.status} ${response.statusText} — ${text}`);
  }
  return response.json();
}

/** Maximum number of pages to follow during pagination to prevent runaway loops. */
const MAX_PAGES = 100;

/**
 * Paginate through Bitbucket's { next, values } pattern.
 * Stops after MAX_PAGES to guard against infinite loops or API bugs.
 */
export async function paginateAll<T>(
  firstPage: { next?: string; values?: readonly T[] },
  fetchNext: (url: string) => Promise<{ next?: string; values?: readonly T[] }>,
): Promise<T[]> {
  const allValues: T[] = [...(firstPage.values ?? [])];
  let nextUrl = firstPage.next;
  let pages = 0;

  while (nextUrl && pages < MAX_PAGES) {
    const page = await fetchNext(nextUrl);
    allValues.push(...(page.values ?? []));
    nextUrl = page.next;
    pages++;
  }

  return allValues;
}

/** Base URL for comment operations on a specific PR. */
function commentsUrl(workspace: string, repo_slug: string, pr_id: number): string {
  return `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo_slug}/pullrequests/${pr_id}/comments`;
}

/**
 * Post inline comments for findings on a Bitbucket PR. Returns posted/failed lists.
 */
async function postInlineComments(
  findings: Finding[],
  workspace: string,
  repo_slug: string,
  pr_id: number,
  username: string,
  token: string,
): Promise<{
  posted: Array<{ path: string; line: number }>;
  failed: Array<{ path: string; line: number; error: string }>;
}> {
  const url = commentsUrl(workspace, repo_slug, pr_id);
  const posted: Array<{ path: string; line: number }> = [];
  const failed: Array<{ path: string; line: number; error: string }> = [];

  for (const finding of findings) {
    const body = buildCommentBody(finding);

    try {
      await postJson(
        url,
        { content: { raw: body }, inline: { path: finding.file, to: finding.line } },
        username,
        token,
      );
      posted.push({ path: finding.file, line: finding.line });
    } catch (error) {
      failed.push({
        path: finding.file,
        line: finding.line,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { posted, failed };
}

/**
 * Post a general (non-inline) comment on a Bitbucket PR.
 * Returns the comment ID if available.
 */
async function postGeneralComment(
  body: string,
  workspace: string,
  repo_slug: string,
  pr_id: number,
  username: string,
  token: string,
): Promise<number | undefined> {
  const url = commentsUrl(workspace, repo_slug, pr_id);
  const raw = await postJson(url, { content: { raw: body } }, username, token);
  const result = BbCommentSchema.safeParse(raw);
  return result.success ? result.data.id : undefined;
}

/**
 * Fetch all PR comments with pagination. Parses through Zod.
 */
async function fetchAllComments(
  workspace: string,
  repo_slug: string,
  pr_id: number,
  username: string,
  token: string,
): Promise<BbComment[]> {
  const url = commentsUrl(workspace, repo_slug, pr_id);
  const raw = await fetchRaw(url, username, token);
  const firstPage = BbPaginatedCommentsSchema.parse(JSON.parse(raw));

  return paginateAll(firstPage, async (nextUrl) => {
    const nextRaw = await fetchRaw(nextUrl, username, token);
    return BbPaginatedCommentsSchema.parse(JSON.parse(nextRaw));
  });
}

/**
 * Sanitize PR description for Bitbucket rendering.
 *
 * Strips markdown image/badge syntax that Bitbucket renders poorly:
 * - Badge links: [![alt](img-url)](link-url)
 * - Inline images: ![alt](img-url)
 * - Collapses multiple blank lines into one
 */
export function sanitizeDescription(text: string): string {
  return text
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Thread {
  comment_id: number;
  path: string | undefined;
  line: number | undefined;
  body: string;
  user: string;
  replies: Array<{ user: string; body: string; created_at: string }>;
}

/**
 * Group flat comment list into threads (root + replies), filtered to a specific user.
 * Pure function — no API calls.
 */
export function groupThreads(comments: BbComment[], botUserUuid: string): Thread[] {
  const roots = new Map<number, Thread>();

  const orphanReplies: Array<{
    parent_id: number;
    user: string;
    body: string;
    created_at: string;
  }> = [];

  for (const c of comments) {
    const commentId = c.id;
    if (commentId === undefined) continue;

    const parentId = c.parent?.id;
    const userUuid = c.user?.uuid ?? "";
    const body = c.content?.raw ?? "";

    if (!parentId) {
      roots.set(commentId, {
        comment_id: commentId,
        path: c.inline?.path,
        line: c.inline?.to ?? c.inline?.from ?? undefined,
        body,
        user: userUuid,
        replies: [],
      });
    } else {
      orphanReplies.push({
        parent_id: parentId,
        user: userUuid,
        body,
        created_at: c.created_on ?? "",
      });
    }
  }

  for (const r of orphanReplies) {
    const root = roots.get(r.parent_id);
    if (root) {
      root.replies.push({ user: r.user, body: r.body, created_at: r.created_at });
    }
  }

  return [...roots.values()].filter((t) => t.user === botUserUuid);
}

/**
 * bb — lightweight Bitbucket Cloud agent.
 *
 * Executes structured Bitbucket operations (clone, PR metadata, diff, review)
 * without an LLM. Deterministic, fast, and cheap.
 */
export const bbAgent = createAgent<string, BbOutput>({
  id: "bb",
  displayName: "Bitbucket Cloud",
  version: "1.0.0",
  description: [
    "<role>",
    "You are a deterministic Bitbucket Cloud API agent. You execute structured operations against the",
    "Bitbucket REST API v2 without any LLM reasoning. You parse a JSON operation document from the",
    "prompt and make direct API calls or git commands, returning structured results.",
    "</role>",
    "",
    "<how_to_use>",
    "1. Include a JSON document in the prompt containing an 'operation' field.",
    "2. The agent extracts the first valid JSON object (supports code fences, inline JSON, or raw JSON).",
    "3. The JSON must match one of the operation schemas below exactly.",
    "4. The agent executes the API call and returns a structured result.",
    "This agent is deterministic — the same input always produces the same API call.",
    "</how_to_use>",
    "",
    "<operations>",
    "<operation name='clone'>",
    "Clone a repository and check out a PR's source branch. Returns the local clone path,",
    "branch name, head SHA, PR metadata, and list of changed files via diffstat.",
    "Required fields: operation, pr_url",
    'Schema: { "operation": "clone", "pr_url": "https://bitbucket.org/ws/repo/pull-requests/123" }',
    "</operation>",
    "",
    "<operation name='repo-clone'>",
    "Clone a repository by URL (no PR required). Optionally check out a specific branch.",
    "Returns the local clone path, repo identifier, and current branch name.",
    "Required fields: operation, repo_url",
    "Optional fields: branch",
    'Schema: { "operation": "repo-clone", "repo_url": "https://bitbucket.org/ws/repo", "branch": "develop" }',
    "</operation>",
    "",
    "<operation name='repo-push'>",
    "Push a local branch to the remote Bitbucket repository. Uses the repo_url for authentication.",
    "Required fields: operation, path (local clone path), branch, repo_url",
    'Schema: { "operation": "repo-push", "path": "/tmp/bb-clone-...", "branch": "fix/dev-5", "repo_url": "https://bitbucket.org/ws/repo" }',
    "</operation>",
    "",
    "<operation name='pr-view'>",
    "Fetch pull request metadata: title, description, author, state, source/destination branches,",
    "head SHA, created/updated timestamps.",
    "Required fields: operation, pr_url",
    "Optional fields: fields (array of specific fields to return)",
    'Schema: { "operation": "pr-view", "pr_url": "https://bitbucket.org/ws/repo/pull-requests/123" }',
    "</operation>",
    "",
    "<operation name='pr-diff'>",
    "Fetch the diff for a pull request. With name_only=true, returns only file paths.",
    "Required fields: operation, pr_url",
    "Optional fields: name_only (boolean, default false)",
    'Schema: { "operation": "pr-diff", "pr_url": "https://bitbucket.org/ws/repo/pull-requests/123", "name_only": true }',
    "</operation>",
    "",
    "<operation name='pr-files'>",
    "Fetch the list of changed files in a pull request via diffstat.",
    "Required fields: operation, pr_url",
    'Schema: { "operation": "pr-files", "pr_url": "https://bitbucket.org/ws/repo/pull-requests/123" }',
    "</operation>",
    "",
    "<operation name='pr-review'>",
    "Post a general comment on a pull request.",
    "Required fields: operation, pr_url, body",
    'Schema: { "operation": "pr-review", "pr_url": "https://bitbucket.org/ws/repo/pull-requests/123", "body": "LGTM" }',
    "</operation>",
    "",
    "<operation name='pr-inline-review'>",
    "Post inline code review comments with findings at specific file/line locations,",
    "plus a summary comment with verdict. Findings that fall outside the diff range are",
    "included in the summary instead.",
    "Required fields: operation, pr_url, verdict, summary, findings",
    "Optional fields: commit_id",
    "Finding fields: severity, category, file, line, title, description, suggestion (optional)",
    'Schema: { "operation": "pr-inline-review", "pr_url": "https://bitbucket.org/ws/repo/pull-requests/123",',
    '  "verdict": "APPROVE", "summary": "Clean code", "findings": [{ "severity": "INFO",',
    '  "category": "style", "file": "src/app.ts", "line": 42, "title": "Nit", "description": "Minor style issue" }] }',
    "</operation>",
    "",
    "<operation name='pr-read-threads'>",
    "Read all bot-authored review threads on a PR. Groups comments into threads",
    "with replies. Used for follow-up reviews to see author responses.",
    "Required fields: operation, pr_url",
    'Schema: { "operation": "pr-read-threads", "pr_url": "https://bitbucket.org/ws/repo/pull-requests/123" }',
    "</operation>",
    "",
    "<operation name='pr-post-followup'>",
    "Post follow-up replies to existing threads and new inline findings.",
    "Required fields: operation, pr_url, thread_replies, new_findings, summary",
    "Optional fields: commit_id",
    'Schema: { "operation": "pr-post-followup", "pr_url": "https://bitbucket.org/ws/repo/pull-requests/123",',
    '  "thread_replies": [{ "comment_id": 100, "body": "Fixed" }], "new_findings": [], "summary": "Follow-up done" }',
    "</operation>",
    "",
    "<operation name='pr-create'>",
    "Create a new pull request. Two modes for the description:",
    "1. Free-form: pass a 'description' string (sanitized automatically — badge/image syntax stripped).",
    "2. Structured: pass 'issue_key', 'summary', and 'files_changed' — the agent builds a clean",
    "   description with 'Fixes {key}', the summary, and a file list. Preferred for pipelines.",
    "If neither is provided, no description is set.",
    "Required fields: operation, repo_url, source_branch, title",
    "Optional fields: destination_branch (default: main), description, issue_key, summary,",
    "  files_changed (string array), close_source_branch",
    'Schema (structured): { "operation": "pr-create", "repo_url": "https://bitbucket.org/ws/repo",',
    '  "source_branch": "fix/dev-4", "title": "DEV-4: Fix the bug", "issue_key": "DEV-4",',
    '  "summary": "Added missing badge", "files_changed": ["README.md"] }',
    "</operation>",
    "</operations>",
    "",
    "<output_format>",
    "All operations return: { operation: string, success: boolean, data: { ...operation-specific fields } }",
    "On error, returns: { ok: false, error: { reason: string } } with credentials redacted.",
    "</output_format>",
    "",
    "<error_handling>",
    "- Invalid PR URL: Agent throws if hostname is not bitbucket.org or path is malformed.",
    "- Repository not found: Bitbucket API returns 404, agent returns error with reason.",
    "- PR not found: Bitbucket API returns 404, agent returns error with PR number.",
    "- Auth failure (401/403): Agent returns error. Check BITBUCKET_USERNAME and BITBUCKET_TOKEN.",
    "- Clone failure: Git clone errors are caught, temp directory cleaned up, error returned.",
    "- Inline review outside diff range: Comment is included in the summary instead of inline.",
    "- All errors redact credentials (username, token, base64) from the message.",
    "</error_handling>",
  ].join("\n"),
  constraints: [
    "Requires two environment variables: BITBUCKET_USERNAME (account email) and BITBUCKET_TOKEN",
    "(app password from https://bitbucket.org/account/settings/app-passwords/). Only supports",
    "Bitbucket Cloud (REST API v2). Bitbucket Server/Data Center use different APIs and are",
    "not supported.",
  ].join(" "),
  expertise: {
    examples: [
      "<examples>",
      "<example>",
      "Input: Clone a PR's source branch for code review",
      'JSON: {"operation":"clone","pr_url":"https://bitbucket.org/ws/repo/pull-requests/42"}',
      'Output: { operation: "clone", success: true, data: { path: "/tmp/bb-clone-...", branch: "feature/auth", head_sha: "abc123", changed_files: ["src/auth.ts"] } }',
      "</example>",
      "<example>",
      "Input: Clone a repository without a PR",
      'JSON: {"operation":"repo-clone","repo_url":"https://bitbucket.org/ws/repo"}',
      'Output: { operation: "repo-clone", success: true, data: { path: "/tmp/bb-clone-...", repo: "ws/repo", branch: "main" } }',
      "</example>",
      "<example>",
      "Input: Get the list of changed files in a PR",
      'JSON: {"operation":"pr-files","pr_url":"https://bitbucket.org/ws/repo/pull-requests/42"}',
      'Output: { operation: "pr-files", success: true, data: { files: ["src/auth.ts", "tests/auth.test.ts"], count: 2 } }',
      "</example>",
      "<example>",
      "Input: Post inline code review findings",
      'JSON: {"operation":"pr-inline-review","pr_url":"https://bitbucket.org/ws/repo/pull-requests/42",',
      '  "verdict":"REQUEST_CHANGES","summary":"Found issues","findings":[{"severity":"CRITICAL",',
      '  "category":"security","file":"src/auth.ts","line":42,"title":"SQL injection","description":"Unsanitized input"}]}',
      'Output: { operation: "pr-inline-review", success: true, data: { posted_comments: 1, failed_comments: 0 } }',
      "</example>",
      "<example>",
      "Input: Create a pull request with structured description",
      'JSON: {"operation":"pr-create","repo_url":"https://bitbucket.org/ws/repo",',
      '  "source_branch":"fix/dev-4","title":"DEV-4: Fix the bug","issue_key":"DEV-4",',
      '  "summary":"Added missing PyPI badge","files_changed":["README.md"],"close_source_branch":true}',
      'Output: { operation: "pr-create", success: true, data: { pr_number: 42, pr_url: "https://bitbucket.org/ws/repo/pull-requests/42" } }',
      "</example>",
      "<example>",
      "Input: Read existing review threads for follow-up",
      'JSON: {"operation":"pr-read-threads","pr_url":"https://bitbucket.org/ws/repo/pull-requests/42"}',
      'Output: { operation: "pr-read-threads", success: true, data: { bot_user: "{uuid}", total_threads: 3, threads_with_replies: 1 } }',
      "</example>",
      "</examples>",
    ],
  },
  outputSchema: BbOutputSchema,
  environment: {
    required: [
      {
        name: "BITBUCKET_USERNAME",
        description: "Bitbucket username (email)",
        linkRef: { provider: "bitbucket", key: "username" },
      },
      {
        name: "BITBUCKET_TOKEN",
        description: "Bitbucket app password",
        linkRef: { provider: "bitbucket", key: "app_password" },
      },
    ],
  },

  handler: async (prompt, context) => {
    const { env, logger } = context;

    const username = env.BITBUCKET_USERNAME ?? process.env.BITBUCKET_USERNAME;
    const token = env.BITBUCKET_TOKEN ?? process.env.BITBUCKET_TOKEN;
    if (!username || !token) {
      return err("BITBUCKET_USERNAME and BITBUCKET_TOKEN environment variables must be set");
    }

    let config: OperationConfig;
    try {
      config = parseOperationConfig(prompt);
    } catch (error) {
      return err(
        `Failed to parse operation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    logger.info("Executing bb operation", { operation: config.operation });

    const client = createClient(username, token);

    try {
      switch (config.operation) {
        case "clone": {
          const { workspace, repo_slug, pr_id } = parsePrUrl(config.pr_url);

          // Get PR metadata via typed client
          const { data: pr, error: prError } = await client.GET(
            "/repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}",
            { params: { path: { workspace, repo_slug, pull_request_id: pr_id } } },
          );

          if (!pr) {
            return err(`Failed to fetch PR #${pr_id}: ${JSON.stringify(prError)}`);
          }

          const sourceBranch = pr.source?.branch?.name;
          const destBranch = pr.destination?.branch?.name;
          const headSha = pr.source?.commit?.hash;

          if (!sourceBranch) {
            return err("PR source branch not found in metadata");
          }

          // Clone using GIT_ASKPASS to avoid embedding credentials in URL/logs.
          // Bitbucket API tokens require "x-bitbucket-api-token-auth" as the git username
          // (not the user's email). See: https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/
          //
          // The askpass script reads credentials from env vars (BB_ASKPASS_USER/BB_ASKPASS_PASS)
          // so the token is never written to disk — only passed via process environment.
          const dir = join(tmpdir(), `bb-clone-${crypto.randomUUID()}`);
          const cloneUrl = `https://bitbucket.org/${workspace}/${repo_slug}.git`;
          const askpassScript = join(tmpdir(), `bb-askpass-${crypto.randomUUID()}.sh`);
          await writeFile(
            askpassScript,
            '#!/bin/sh\ncase "$1" in\n*Username*) printf \'%s\\n\' "$BB_ASKPASS_USER";;\n*Password*) printf \'%s\\n\' "$BB_ASKPASS_PASS";;\nesac\n',
            { mode: 0o700 },
          );

          try {
            try {
              await git(
                ["-c", "credential.helper=", "clone", cloneUrl, dir],
                {
                  env: {
                    GIT_ASKPASS: askpassScript,
                    GIT_TERMINAL_PROMPT: "0",
                    BB_ASKPASS_USER: "x-bitbucket-api-token-auth",
                    BB_ASKPASS_PASS: token,
                  },
                },
                [username, token],
              );
            } finally {
              try {
                await unlink(askpassScript);
              } catch {
                /* best-effort cleanup */
              }
            }
            logger.info("Repository cloned", { repo: `${workspace}/${repo_slug}`, dir });

            await git(["checkout", sourceBranch], { cwd: dir });
            const branch = await git(["branch", "--show-current"], { cwd: dir });
            logger.info("PR branch checked out", { pr_id, branch });

            // Get changed files via diffstat (raw fetch — 302 redirect)
            const diffstatUrl = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo_slug}/pullrequests/${pr_id}/diffstat`;
            const diffstatRaw = await fetchRaw(diffstatUrl, username, token);
            const diffstatData = BbPaginatedDiffstatSchema.parse(JSON.parse(diffstatRaw));

            const changedFiles: string[] = [];
            const allDiffstatValues = await paginateAll(diffstatData, async (url) => {
              const raw = await fetchRaw(url, username, token);
              return BbPaginatedDiffstatSchema.parse(JSON.parse(raw));
            });

            for (const entry of allDiffstatValues) {
              const filePath = entry.new?.path ?? entry.old?.path;
              if (filePath) changedFiles.push(filePath);
            }

            return ok({
              operation: "clone",
              success: true,
              data: {
                path: dir,
                repo: `${workspace}/${repo_slug}`,
                branch,
                base_branch: destBranch,
                pr_number: pr_id,
                pr_url: config.pr_url,
                head_sha: headSha,
                pr_metadata: {
                  title: pr.title,
                  description: pr.summary?.raw,
                  author: pr.author?.display_name,
                  state: pr.state,
                  source: pr.source,
                  destination: pr.destination,
                },
                changed_files: changedFiles,
              },
            });
          } catch (cloneErr) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
            throw cloneErr;
          }
        }

        case "repo-clone": {
          const { workspace, repo_slug } = parseRepoUrl(config.repo_url);

          const dir = join(tmpdir(), `bb-clone-${crypto.randomUUID()}`);
          const cloneUrl = `https://bitbucket.org/${workspace}/${repo_slug}.git`;
          const askpassScript = join(tmpdir(), `bb-askpass-${crypto.randomUUID()}.sh`);
          await writeFile(
            askpassScript,
            '#!/bin/sh\ncase "$1" in\n*Username*) printf \'%s\\n\' "$BB_ASKPASS_USER";;\n*Password*) printf \'%s\\n\' "$BB_ASKPASS_PASS";;\nesac\n',
            { mode: 0o700 },
          );

          try {
            try {
              await git(
                ["-c", "credential.helper=", "clone", cloneUrl, dir],
                {
                  env: {
                    GIT_ASKPASS: askpassScript,
                    GIT_TERMINAL_PROMPT: "0",
                    BB_ASKPASS_USER: "x-bitbucket-api-token-auth",
                    BB_ASKPASS_PASS: token,
                  },
                },
                [username, token],
              );
            } finally {
              try {
                await unlink(askpassScript);
              } catch {
                /* best-effort cleanup */
              }
            }
            logger.info("Repository cloned", { repo: `${workspace}/${repo_slug}`, dir });

            if (config.branch) {
              await git(["checkout", config.branch], { cwd: dir });
              logger.info("Branch checked out", { branch: config.branch });
            }

            const branch = await git(["branch", "--show-current"], { cwd: dir });

            return ok({
              operation: "repo-clone",
              success: true,
              data: { path: dir, repo: `${workspace}/${repo_slug}`, branch },
            });
          } catch (cloneErr) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
            throw cloneErr;
          }
        }

        case "repo-push": {
          const { workspace, repo_slug } = parseRepoUrl(config.repo_url);

          const askpassScript = join(tmpdir(), `bb-askpass-${crypto.randomUUID()}.sh`);
          await writeFile(
            askpassScript,
            '#!/bin/sh\ncase "$1" in\n*Username*) printf \'%s\\n\' "$BB_ASKPASS_USER";;\n*Password*) printf \'%s\\n\' "$BB_ASKPASS_PASS";;\nesac\n',
            { mode: 0o700 },
          );

          try {
            await git(
              ["-c", "credential.helper=", "push", "-u", "origin", config.branch],
              {
                cwd: config.path,
                env: {
                  GIT_ASKPASS: askpassScript,
                  GIT_TERMINAL_PROMPT: "0",
                  BB_ASKPASS_USER: "x-bitbucket-api-token-auth",
                  BB_ASKPASS_PASS: token,
                },
              },
              [username, token],
            );
          } finally {
            try {
              await unlink(askpassScript);
            } catch {
              /* best-effort cleanup */
            }
          }

          return ok({
            operation: "repo-push",
            success: true,
            data: { repo: `${workspace}/${repo_slug}`, branch: config.branch },
          });
        }

        case "pr-view": {
          const { workspace, repo_slug, pr_id } = parsePrUrl(config.pr_url);

          const { data: pr, error: prError } = await client.GET(
            "/repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}",
            { params: { path: { workspace, repo_slug, pull_request_id: pr_id } } },
          );

          if (!pr) {
            return err(`Failed to fetch PR #${pr_id}: ${JSON.stringify(prError)}`);
          }

          return ok({
            operation: "pr-view",
            success: true,
            data: {
              title: pr.title,
              description: pr.summary?.raw,
              author: pr.author?.display_name,
              author_uuid: pr.author?.uuid,
              state: pr.state,
              source_branch: pr.source?.branch?.name,
              destination_branch: pr.destination?.branch?.name,
              head_sha: pr.source?.commit?.hash,
              created_on: pr.created_on,
              updated_on: pr.updated_on,
            },
          });
        }

        case "pr-diff": {
          const { workspace, repo_slug, pr_id } = parsePrUrl(config.pr_url);

          const diffUrl = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo_slug}/pullrequests/${pr_id}/diff`;
          const diff = await fetchRaw(diffUrl, username, token);

          if (config.name_only) {
            // Parse diff headers to extract file paths
            const filePattern = /^diff --git a\/.+ b\/(.+)$/gm;
            const files: string[] = [];
            for (const match of diff.matchAll(filePattern)) {
              if (match[1]) files.push(match[1]);
            }
            return ok({ operation: "pr-diff", success: true, data: { diff: files.join("\n") } });
          }

          return ok({ operation: "pr-diff", success: true, data: { diff } });
        }

        case "pr-files": {
          const { workspace, repo_slug, pr_id } = parsePrUrl(config.pr_url);

          const diffstatUrl = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo_slug}/pullrequests/${pr_id}/diffstat`;
          const diffstatRaw = await fetchRaw(diffstatUrl, username, token);
          const firstPage = BbPaginatedDiffstatSchema.parse(JSON.parse(diffstatRaw));

          const allEntries = await paginateAll(firstPage, async (url) => {
            const raw = await fetchRaw(url, username, token);
            return BbPaginatedDiffstatSchema.parse(JSON.parse(raw));
          });

          const files: string[] = [];
          for (const entry of allEntries) {
            const filePath = entry.new?.path ?? entry.old?.path;
            if (filePath) files.push(filePath);
          }

          return ok({ operation: "pr-files", success: true, data: { files, count: files.length } });
        }

        case "pr-review": {
          const { workspace, repo_slug, pr_id } = parsePrUrl(config.pr_url);

          const commentId = await postGeneralComment(
            config.body,
            workspace,
            repo_slug,
            pr_id,
            username,
            token,
          );

          return ok({
            operation: "pr-review",
            success: true,
            data: { pr_number: pr_id, repo: `${workspace}/${repo_slug}`, comment_id: commentId },
          });
        }

        case "pr-inline-review": {
          const { workspace, repo_slug, pr_id } = parsePrUrl(config.pr_url);

          const { posted, failed } = await postInlineComments(
            config.findings,
            workspace,
            repo_slug,
            pr_id,
            username,
            token,
          );

          const summaryParts = [
            `## Code Review`,
            "",
            `**Verdict:** ${config.verdict}`,
            "",
            `### Summary`,
            "",
            config.summary,
            "",
            "---",
            "",
            `> ${config.findings.length} findings: ${posted.length} inline` +
              (failed.length > 0 ? `, ${failed.length} in summary (outside diff range)` : ""),
            ...buildFailedFindingsSummary(failed, config.findings),
            "",
            "---",
            "",
            "*Automated review by Friday*",
          ];

          await postGeneralComment(
            summaryParts.join("\n"),
            workspace,
            repo_slug,
            pr_id,
            username,
            token,
          );

          return ok({
            operation: "pr-inline-review",
            success: true,
            data: {
              pr_number: pr_id,
              repo: `${workspace}/${repo_slug}`,
              posted_comments: posted.length,
              failed_comments: failed.length,
            },
          });
        }

        case "pr-read-threads": {
          const { workspace, repo_slug, pr_id } = parsePrUrl(config.pr_url);

          // Get current user UUID via typed client
          const { data: currentUser, error: userError } = await client.GET("/user", {});
          if (!currentUser) {
            return err(`Failed to identify bot user: ${JSON.stringify(userError)}`);
          }
          const botUserUuid = currentUser.uuid ?? "";

          // Get all comments via raw fetch + Zod parsing
          const allComments = await fetchAllComments(workspace, repo_slug, pr_id, username, token);

          const fridayThreads = groupThreads(allComments, botUserUuid);

          return ok({
            operation: "pr-read-threads",
            success: true,
            data: {
              bot_user: botUserUuid,
              threads: fridayThreads,
              total_threads: fridayThreads.length,
              threads_with_replies: fridayThreads.filter((t) => t.replies.length > 0).length,
            },
          });
        }

        case "pr-post-followup": {
          const { workspace, repo_slug, pr_id } = parsePrUrl(config.pr_url);
          const url = commentsUrl(workspace, repo_slug, pr_id);

          // Post thread replies via raw fetch
          let repliesPosted = 0;
          for (const reply of config.thread_replies) {
            try {
              await postJson(
                url,
                { content: { raw: reply.body }, parent: { id: reply.comment_id } },
                username,
                token,
              );
              repliesPosted++;
            } catch {
              // Thread may be outdated or comment deleted — skip
            }
          }

          // Post new inline findings
          const { posted, failed } = await postInlineComments(
            config.new_findings,
            workspace,
            repo_slug,
            pr_id,
            username,
            token,
          );

          // Post summary comment
          const summaryParts = [
            `## Follow-up Review`,
            "",
            config.summary,
            "",
            "---",
            "",
            `> ${repliesPosted} thread replies, ${posted.length} new inline comments` +
              (failed.length > 0 ? `, ${failed.length} in summary` : ""),
            ...buildFailedFindingsSummary(failed, config.new_findings),
            "",
            "---",
            "",
            "*Automated follow-up by Friday*",
          ];

          await postGeneralComment(
            summaryParts.join("\n"),
            workspace,
            repo_slug,
            pr_id,
            username,
            token,
          );

          return ok({
            operation: "pr-post-followup",
            success: true,
            data: {
              pr_number: pr_id,
              repo: `${workspace}/${repo_slug}`,
              thread_replies_posted: repliesPosted,
              new_comments_posted: posted.length,
              failed_comments: failed.length,
            },
          });
        }

        case "pr-create": {
          const { workspace, repo_slug } = parseRepoUrl(config.repo_url);
          const destBranch = config.destination_branch ?? "main";

          // Build description: use free-form if provided, otherwise assemble from structured fields
          let prDescription: string | undefined;
          if (config.description) {
            prDescription = sanitizeDescription(config.description);
          } else if (
            config.summary !== undefined ||
            config.issue_key !== undefined ||
            config.files_changed !== undefined
          ) {
            const parts: string[] = [];
            if (config.issue_key) {
              parts.push(`Fixes ${config.issue_key}`);
            }
            if (config.summary) {
              parts.push("", sanitizeDescription(config.summary));
            }
            if (config.files_changed && config.files_changed.length > 0) {
              parts.push("", "### Changes", "", ...config.files_changed.map((f) => `- ${f}`));
            }
            parts.push("", "---", "", "*Automated by Friday*");
            prDescription = parts.join("\n");
          }

          const prBody: Record<string, unknown> = {
            title: config.title,
            source: { branch: { name: config.source_branch } },
            destination: { branch: { name: destBranch } },
          };

          if (prDescription) {
            prBody.description = prDescription;
          }
          if (config.close_source_branch !== undefined) {
            prBody.close_source_branch = config.close_source_branch;
          }

          const createUrl = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo_slug}/pullrequests`;
          const raw = await postJson(createUrl, prBody, username, token);

          // Parse PR ID and URL from response
          const prResponse = z
            .object({
              id: z.number(),
              links: z.object({ html: z.object({ href: z.string() }).optional() }).optional(),
            })
            .safeParse(raw);

          const prId = prResponse.success ? prResponse.data.id : undefined;
          const prHtmlUrl = prResponse.success ? prResponse.data.links?.html?.href : undefined;

          logger.info("Pull request created", { repo: `${workspace}/${repo_slug}`, pr_id: prId });

          return ok({
            operation: "pr-create",
            success: true,
            data: {
              pr_number: prId,
              pr_url:
                prHtmlUrl ??
                `https://bitbucket.org/${workspace}/${repo_slug}/pull-requests/${prId}`,
              repo: `${workspace}/${repo_slug}`,
              source_branch: config.source_branch,
              destination_branch: destBranch,
              title: config.title,
            },
          });
        }

        default: {
          const _exhaustive: never = config;
          return err(`Unknown operation: ${(_exhaustive as OperationConfig).operation}`);
        }
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      // Redact credentials from any error messages — API clients and fetch
      // implementations may include auth headers or URLs in error output.
      for (const secret of [username, token, btoa(`${username}:${token}`)]) {
        message = message.replaceAll(secret, "***");
      }
      logger.error("bb operation failed", { operation: config.operation, error: message });
      return err(`bb ${config.operation} failed: ${message}`);
    }
  },
});
