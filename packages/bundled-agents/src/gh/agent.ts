import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createAgent, err, ok } from "@atlas/agent-sdk";
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
 * Output schema for gh agent operations.
 */
export const GhOutputSchema = z.object({
  operation: z.string().describe("The operation that was executed"),
  success: z.boolean().describe("Whether the operation succeeded"),
  data: z.object({}).catchall(z.unknown()).describe("Operation-specific output data"),
});

export type GhOutput = z.infer<typeof GhOutputSchema>;

/**
 * Parse a GitHub PR URL into its components using URL parsing.
 *
 * Accepts: https://github.com/owner/repo/pull/123
 * Returns: { owner, repo, pr_number }
 */
function parsePrUrl(prUrl: string): { owner: string; repo: string; pr_number: number } {
  const url = new URL(prUrl);
  if (url.hostname !== "github.com") {
    throw new Error(`Expected github.com URL, got: ${url.hostname}`);
  }

  // pathname: /owner/repo/pull/123
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repo = segments[1];
  const pullSegment = segments[2];
  const prNumberStr = segments[3];

  if (!owner || !repo || pullSegment !== "pull" || !prNumberStr) {
    throw new Error(`Invalid PR URL path: ${url.pathname}. Expected: /owner/repo/pull/123`);
  }

  const prNumber = parseInt(prNumberStr, 10);
  if (Number.isNaN(prNumber)) {
    throw new Error(`Invalid PR number in URL: ${prNumberStr}`);
  }

  return { owner, repo, pr_number: prNumber };
}

/**
 * Schemas for individual operations parsed from the prompt's JSON config.
 *
 * All PR operations accept `pr_url` directly — the agent parses
 * owner/repo/pr_number internally via URL parsing.
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
  commit_id: z.string(),
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
  commit_id: z.string(),
  thread_replies: z.array(z.object({ comment_id: z.number(), body: z.string() })),
  new_findings: z.array(FindingSchema),
  summary: z.string(),
});

/**
 * Zod schema for GitHub PR metadata from `gh pr view --json`.
 * Parses the JSON response instead of using `as` assertions.
 */
const GhPrMetadataSchema = z.object({}).catchall(z.unknown());

/**
 * Zod schema for GitHub PR review comment API responses.
 * Used by pr-read-threads to parse `gh api repos/.../pulls/.../comments`.
 */
const GhCommentSchema = z.object({
  id: z.number(),
  in_reply_to_id: z.number().nullish(),
  user: z.object({ login: z.string() }),
  body: z.string(),
  path: z.string(),
  line: z.number().nullish(),
  original_line: z.number().nullish(),
  created_at: z.string(),
});

const GhCommentsArraySchema = z.array(GhCommentSchema);

const OperationConfigSchema = z.discriminatedUnion("operation", [
  CloneConfigSchema,
  PrViewConfigSchema,
  PrDiffConfigSchema,
  PrReviewConfigSchema,
  PrFilesConfigSchema,
  PrInlineReviewConfigSchema,
  PrReadThreadsConfigSchema,
  PrPostFollowupConfigSchema,
]);

type OperationConfig = z.infer<typeof OperationConfigSchema>;

/**
 * Parse the operation config from the prompt string.
 *
 * Delegates to the shared operation parser which handles code fences,
 * balanced-brace raw JSON extraction, and full-prompt fallback.
 */
function parseOperationConfig(prompt: string): OperationConfig {
  return parseOpConfig(prompt, OperationConfigSchema);
}

/**
 * Execute a gh CLI command with the given token.
 */
async function gh(
  args: string[],
  options: { ghToken: string; cwd?: string; maxBuffer?: number },
): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    env: { ...process.env, GH_TOKEN: options.ghToken },
    cwd: options.cwd,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024, // 10MB
  });
  return stdout.trim();
}

/**
 * Execute a git command.
 */
async function git(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
  });
  return stdout.trim();
}

/**
 * Post findings as inline PR review comments. Returns posted/failed lists.
 */
async function postInlineComments(
  findings: Finding[],
  nwo: string,
  pr_number: number,
  commit_id: string,
  ghToken: string,
): Promise<{
  posted: Array<{ path: string; line: number }>;
  failed: Array<{ path: string; line: number; error: string }>;
}> {
  const posted: Array<{ path: string; line: number }> = [];
  const failed: Array<{ path: string; line: number; error: string }> = [];

  for (const finding of findings) {
    const body = buildCommentBody(finding);

    const args = [
      "api",
      `repos/${nwo}/pulls/${pr_number}/comments`,
      "-f",
      `body=${body}`,
      "-f",
      `path=${finding.file}`,
      "-f",
      `commit_id=${commit_id}`,
      "-F",
      `line=${finding.line}`,
      "-f",
      "side=RIGHT",
    ];

    if (finding.start_line && finding.start_line !== finding.line) {
      args.push("-F", `start_line=${finding.start_line}`, "-f", "start_side=RIGHT");
    }

    try {
      await gh(args, { ghToken });
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
 * Post a review summary comment on a PR.
 */
async function postReviewSummary(
  summaryBody: string,
  nwo: string,
  pr_number: number,
  ghToken: string,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "gh-review-"));
  const bodyFile = join(tempDir, "review-body.md");
  await writeFile(bodyFile, summaryBody, "utf-8");
  try {
    await gh(
      ["pr", "review", String(pr_number), "--repo", nwo, "--comment", "--body-file", bodyFile],
      { ghToken },
    );
  } finally {
    await unlink(bodyFile).catch(() => {});
  }
}

/**
 * gh — lightweight GitHub CLI agent.
 *
 * Executes structured GitHub operations (clone, PR metadata, diff, review)
 * without an LLM. Deterministic, fast, and cheap.
 */
export const ghAgent = createAgent<string, GhOutput>({
  id: "gh",
  displayName: "GitHub CLI",
  version: "1.0.0",
  description: [
    "<role>",
    "You are a deterministic GitHub CLI agent. You execute structured operations against the",
    "GitHub CLI (gh) and git without any LLM reasoning. You parse a JSON operation document from the",
    "prompt and make direct CLI calls, returning structured results.",
    "</role>",
    "",
    "<how_to_use>",
    "1. Include a JSON document in the prompt containing an 'operation' field.",
    "2. The agent extracts the first valid JSON object (supports code fences, inline JSON, or raw JSON).",
    "3. The JSON must match one of the operation schemas below exactly.",
    "4. The agent executes the CLI call and returns a structured result.",
    "This agent is deterministic — the same input always produces the same CLI call.",
    "</how_to_use>",
    "",
    "<operations>",
    "<operation name='clone'>",
    "Clone a repository and check out a PR's branch. Returns the local clone path,",
    "branch name, head SHA, PR metadata, and list of changed files.",
    "Required fields: operation, pr_url",
    'Schema: { "operation": "clone", "pr_url": "https://github.com/owner/repo/pull/123" }',
    "</operation>",
    "",
    "<operation name='pr-view'>",
    "Fetch pull request metadata: title, body, author, base/head branches, additions,",
    "deletions, changed files count. Optionally specify which fields to return.",
    "Required fields: operation, pr_url",
    "Optional fields: fields (array of specific gh pr view JSON fields)",
    'Schema: { "operation": "pr-view", "pr_url": "https://github.com/owner/repo/pull/123" }',
    "</operation>",
    "",
    "<operation name='pr-diff'>",
    "Fetch the diff for a pull request. With name_only=true, returns only file paths.",
    "Required fields: operation, pr_url",
    "Optional fields: name_only (boolean, default false)",
    'Schema: { "operation": "pr-diff", "pr_url": "https://github.com/owner/repo/pull/123", "name_only": true }',
    "</operation>",
    "",
    "<operation name='pr-files'>",
    "Fetch the list of changed files in a pull request.",
    "Required fields: operation, pr_url",
    'Schema: { "operation": "pr-files", "pr_url": "https://github.com/owner/repo/pull/123" }',
    "</operation>",
    "",
    "<operation name='pr-review'>",
    "Post a review comment on a pull request.",
    "Required fields: operation, pr_url, body",
    'Schema: { "operation": "pr-review", "pr_url": "https://github.com/owner/repo/pull/123", "body": "LGTM" }',
    "</operation>",
    "",
    "<operation name='pr-inline-review'>",
    "Post inline code review comments with findings at specific file/line locations,",
    "plus a summary comment with verdict. Findings that fall outside the diff range are",
    "included in the summary instead.",
    "Required fields: operation, pr_url, commit_id, verdict, summary, findings",
    "Finding fields: severity, category, file, line, title, description, suggestion (optional)",
    'Schema: { "operation": "pr-inline-review", "pr_url": "https://github.com/owner/repo/pull/123",',
    '  "commit_id": "abc123", "verdict": "APPROVE", "summary": "Clean code",',
    '  "findings": [{ "severity": "INFO", "category": "style", "file": "src/app.ts",',
    '  "line": 42, "title": "Nit", "description": "Minor style issue" }] }',
    "</operation>",
    "",
    "<operation name='pr-read-threads'>",
    "Read all bot-authored review threads on a PR. Groups comments into threads",
    "with replies. Used for follow-up reviews to see author responses.",
    "Required fields: operation, pr_url",
    'Schema: { "operation": "pr-read-threads", "pr_url": "https://github.com/owner/repo/pull/123" }',
    "</operation>",
    "",
    "<operation name='pr-post-followup'>",
    "Post follow-up replies to existing threads and new inline findings.",
    "Required fields: operation, pr_url, commit_id, thread_replies, new_findings, summary",
    'Schema: { "operation": "pr-post-followup", "pr_url": "https://github.com/owner/repo/pull/123",',
    '  "commit_id": "abc123", "thread_replies": [{ "comment_id": 100, "body": "Fixed" }],',
    '  "new_findings": [], "summary": "Follow-up done" }',
    "</operation>",
    "</operations>",
    "",
    "<output_format>",
    "All operations return: { operation: string, success: boolean, data: { ...operation-specific fields } }",
    "On error, returns: { ok: false, error: { reason: string } } with credentials redacted.",
    "</output_format>",
    "",
    "<error_handling>",
    "- Invalid PR URL: Agent throws if hostname is not github.com or path is malformed.",
    "- Repository not found: gh CLI returns error, agent returns error with reason.",
    "- PR not found: gh CLI returns error, agent returns error with PR number.",
    "- Auth failure: Agent returns error. Check GH_TOKEN.",
    "- Clone failure: Git clone errors are caught, temp directory cleaned up, error returned.",
    "- Inline review outside diff range: Comment is included in the summary instead of inline.",
    "- All errors redact credentials (token, base64) from the message.",
    "</error_handling>",
  ].join("\n"),
  constraints: [
    "Requires GH_TOKEN environment variable (personal access token or GitHub App installation",
    "token, created at https://github.com/settings/tokens). Only supports GitHub Cloud",
    "repositories. GitHub Enterprise Server uses different API endpoints and is not supported.",
  ].join(" "),
  expertise: {
    examples: [
      "<examples>",
      "<example>",
      "Input: Clone a PR's source branch for code review",
      'JSON: {"operation":"clone","pr_url":"https://github.com/owner/repo/pull/42"}',
      'Output: { operation: "clone", success: true, data: { path: "/tmp/gh-clone-...", branch: "feature/auth", head_sha: "abc123", changed_files: ["src/auth.ts"] } }',
      "</example>",
      "<example>",
      "Input: Get the list of changed files in a PR",
      'JSON: {"operation":"pr-files","pr_url":"https://github.com/owner/repo/pull/42"}',
      'Output: { operation: "pr-files", success: true, data: { files: ["src/auth.ts", "tests/auth.test.ts"], count: 2 } }',
      "</example>",
      "<example>",
      "Input: Get the diff for a pull request",
      'JSON: {"operation":"pr-diff","pr_url":"https://github.com/owner/repo/pull/42"}',
      'Output: { operation: "pr-diff", success: true, data: { diff: "diff --git a/..." } }',
      "</example>",
      "<example>",
      "Input: Post inline code review findings",
      'JSON: {"operation":"pr-inline-review","pr_url":"https://github.com/owner/repo/pull/42",',
      '  "commit_id":"abc123","verdict":"REQUEST_CHANGES","summary":"Found issues",',
      '  "findings":[{"severity":"CRITICAL","category":"security","file":"src/auth.ts",',
      '  "line":42,"title":"SQL injection","description":"Unsanitized input"}]}',
      'Output: { operation: "pr-inline-review", success: true, data: { posted_comments: 1, failed_comments: 0 } }',
      "</example>",
      "<example>",
      "Input: Read existing review threads for follow-up",
      'JSON: {"operation":"pr-read-threads","pr_url":"https://github.com/owner/repo/pull/42"}',
      'Output: { operation: "pr-read-threads", success: true, data: { bot_user: "friday-bot", total_threads: 3, threads_with_replies: 1 } }',
      "</example>",
      "<example>",
      "Input: Post a review comment on a PR",
      'JSON: {"operation":"pr-review","pr_url":"https://github.com/owner/repo/pull/42","body":"Looks good!"}',
      'Output: { operation: "pr-review", success: true, data: { pr_number: 42, repo: "owner/repo", review_url: "https://..." } }',
      "</example>",
      "</examples>",
    ],
  },
  outputSchema: GhOutputSchema,
  environment: {
    required: [
      {
        name: "GH_TOKEN",
        description: "GitHub personal access token for API authentication",
        linkRef: { provider: "github", key: "access_token" },
      },
    ],
  },

  handler: async (prompt, context) => {
    const { env, logger } = context;

    const ghToken = env.GH_TOKEN ?? process.env.GH_TOKEN;
    if (!ghToken) {
      return err("GH_TOKEN environment variable is not set");
    }

    let config: OperationConfig;
    try {
      config = parseOperationConfig(prompt);
    } catch (error) {
      return err(
        `Failed to parse operation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    logger.info("Executing gh operation", { operation: config.operation });

    try {
      switch (config.operation) {
        case "clone": {
          const { owner, repo, pr_number } = parsePrUrl(config.pr_url);
          const nwo = `${owner}/${repo}`;

          const dir = join(tmpdir(), `gh-clone-${crypto.randomUUID()}`);
          try {
            await gh(["repo", "clone", nwo, dir], { ghToken });
            logger.info("Repository cloned", { repo: nwo, dir });

            await gh(["pr", "checkout", String(pr_number)], { ghToken, cwd: dir });
            const branch = await git(["branch", "--show-current"], { cwd: dir });
            logger.info("PR branch checked out", { pr_number, branch });

            const fields =
              "title,body,author,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,files";
            const metadataJson = await gh(["pr", "view", String(pr_number), "--json", fields], {
              ghToken,
              cwd: dir,
            });
            const prMetadata = GhPrMetadataSchema.parse(JSON.parse(metadataJson));

            const filesOutput = await gh(["pr", "diff", String(pr_number), "--name-only"], {
              ghToken,
              cwd: dir,
            });
            const changedFiles = filesOutput.split("\n").filter(Boolean);

            return ok({
              operation: "clone",
              success: true,
              data: {
                path: dir,
                repo: nwo,
                branch,
                base_branch: prMetadata.baseRefName,
                pr_number,
                pr_url: config.pr_url,
                head_sha: prMetadata.headRefOid,
                pr_metadata: prMetadata,
                changed_files: changedFiles,
              },
            });
          } catch (cloneErr) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
            throw cloneErr;
          }
        }

        case "pr-view": {
          const { owner, repo, pr_number } = parsePrUrl(config.pr_url);
          const nwo = `${owner}/${repo}`;
          const defaultFields =
            "title,body,author,baseRefName,headRefName,additions,deletions,changedFiles,files";
          const fields = config.fields?.join(",") ?? defaultFields;
          const metadataJson = await gh(
            ["pr", "view", String(pr_number), "--repo", nwo, "--json", fields],
            { ghToken },
          );
          const metadata = GhPrMetadataSchema.parse(JSON.parse(metadataJson));
          return ok({ operation: "pr-view", success: true, data: metadata });
        }

        case "pr-diff": {
          const { owner, repo, pr_number } = parsePrUrl(config.pr_url);
          const nwo = `${owner}/${repo}`;
          const args = ["pr", "diff", String(pr_number), "--repo", nwo];
          if (config.name_only) args.push("--name-only");
          const diff = await gh(args, { ghToken });
          return ok({ operation: "pr-diff", success: true, data: { diff } });
        }

        case "pr-review": {
          const { owner, repo, pr_number } = parsePrUrl(config.pr_url);
          const nwo = `${owner}/${repo}`;

          // Write review body to temp file
          const tempDir = await mkdtemp(join(tmpdir(), "gh-review-"));
          const bodyFile = join(tempDir, "review-body.md");
          await writeFile(bodyFile, config.body, "utf-8");

          try {
            await gh(
              [
                "pr",
                "review",
                String(pr_number),
                "--repo",
                nwo,
                "--comment",
                "--body-file",
                bodyFile,
              ],
              { ghToken },
            );

            // Verify the review was posted
            const verifyOutput = await gh(
              [
                "pr",
                "view",
                String(pr_number),
                "--repo",
                nwo,
                "--json",
                "reviews",
                "--jq",
                ".reviews[-1].url",
              ],
              { ghToken },
            );

            return ok({
              operation: "pr-review",
              success: true,
              data: { pr_number, repo: nwo, review_url: verifyOutput.trim() },
            });
          } finally {
            await unlink(bodyFile).catch(() => {});
          }
        }

        case "pr-files": {
          const { owner, repo, pr_number } = parsePrUrl(config.pr_url);
          const nwo = `${owner}/${repo}`;
          const filesOutput = await gh(
            ["pr", "diff", String(pr_number), "--repo", nwo, "--name-only"],
            { ghToken },
          );
          const files = filesOutput.split("\n").filter(Boolean);
          return ok({ operation: "pr-files", success: true, data: { files, count: files.length } });
        }

        case "pr-inline-review": {
          const { owner, repo, pr_number } = parsePrUrl(config.pr_url);
          const nwo = `${owner}/${repo}`;

          const { posted, failed } = await postInlineComments(
            config.findings,
            nwo,
            pr_number,
            config.commit_id,
            ghToken,
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

          await postReviewSummary(summaryParts.join("\n"), nwo, pr_number, ghToken);

          return ok({
            operation: "pr-inline-review",
            success: true,
            data: {
              pr_number,
              repo: nwo,
              posted_comments: posted.length,
              failed_comments: failed.length,
            },
          });
        }

        case "pr-read-threads": {
          const { owner, repo, pr_number } = parsePrUrl(config.pr_url);
          const nwo = `${owner}/${repo}`;

          const botUser = await gh(["api", "user", "--jq", ".login"], { ghToken });

          const raw = await gh(["api", `repos/${nwo}/pulls/${pr_number}/comments`, "--paginate"], {
            ghToken,
          });

          const comments = raw ? GhCommentsArraySchema.parse(JSON.parse(raw)) : [];

          const roots = new Map<
            number,
            {
              comment_id: number;
              path: string;
              line: number | null;
              body: string;
              user: string;
              replies: Array<{ user: string; body: string; created_at: string }>;
            }
          >();

          const orphanReplies: Array<{
            in_reply_to_id: number;
            user: string;
            body: string;
            created_at: string;
          }> = [];

          for (const c of comments) {
            if (!c.in_reply_to_id) {
              roots.set(c.id, {
                comment_id: c.id,
                path: c.path,
                line: c.line ?? c.original_line ?? null,
                body: c.body,
                user: c.user.login,
                replies: [],
              });
            } else {
              orphanReplies.push({
                in_reply_to_id: c.in_reply_to_id,
                user: c.user.login,
                body: c.body,
                created_at: c.created_at,
              });
            }
          }

          for (const r of orphanReplies) {
            const root = roots.get(r.in_reply_to_id);
            if (root) {
              root.replies.push({ user: r.user, body: r.body, created_at: r.created_at });
            }
          }

          const fridayThreads = [...roots.values()].filter((t) => t.user === botUser);

          return ok({
            operation: "pr-read-threads",
            success: true,
            data: {
              bot_user: botUser,
              threads: fridayThreads,
              total_threads: fridayThreads.length,
              threads_with_replies: fridayThreads.filter((t) => t.replies.length > 0).length,
            },
          });
        }

        case "pr-post-followup": {
          const { owner, repo, pr_number } = parsePrUrl(config.pr_url);
          const nwo = `${owner}/${repo}`;

          let repliesPosted = 0;
          for (const reply of config.thread_replies) {
            try {
              await gh(
                [
                  "api",
                  `repos/${nwo}/pulls/${pr_number}/comments/${reply.comment_id}/replies`,
                  "-f",
                  `body=${reply.body}`,
                ],
                { ghToken },
              );
              repliesPosted++;
            } catch {
              // Thread may be outdated or comment deleted — skip
            }
          }

          const { posted, failed } = await postInlineComments(
            config.new_findings,
            nwo,
            pr_number,
            config.commit_id,
            ghToken,
          );

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

          await postReviewSummary(summaryParts.join("\n"), nwo, pr_number, ghToken);

          return ok({
            operation: "pr-post-followup",
            success: true,
            data: {
              pr_number,
              repo: nwo,
              thread_replies_posted: repliesPosted,
              new_comments_posted: posted.length,
              failed_comments: failed.length,
            },
          });
        }

        default: {
          const _exhaustive: never = config;
          return err(`Unknown operation: ${String(_exhaustive)}`);
        }
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      // Redact credentials from any error messages — the gh CLI and git
      // can include tokens in stderr output.
      for (const secret of [ghToken, btoa(`x-access-token:${ghToken}`)]) {
        message = message.replaceAll(secret, "***");
      }
      logger.error("gh operation failed", { operation: config.operation, error: message });
      return err(`gh ${config.operation} failed: ${message}`);
    }
  },
});
