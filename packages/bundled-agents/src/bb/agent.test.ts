import { createStubPlatformModels } from "@atlas/llm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildCommentBody, buildFailedFindingsSummary } from "../vcs/schemas.ts";

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports)
// ---------------------------------------------------------------------------
const mockClientGET = vi.hoisted(() => vi.fn());
vi.mock("@coderabbitai/bitbucket/cloud", () => ({
  createBitbucketCloudClient: () => ({ GET: mockClientGET }),
}));

/**
 * Mock for `execFileAsync` (the promisified execFile).
 * Node's `execFile` has `util.promisify.custom` so `promisify(execFile)` returns
 * a function yielding `{stdout, stderr}`. We attach the same symbol to our mock
 * so the agent's top-level `const execFileAsync = promisify(execFile)` resolves
 * to this inner mock.
 */
const mockExecFileAsync = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() => {
  const fn = vi.fn();
  // Use the well-known symbol that util.promisify checks
  Object.defineProperty(fn, Symbol.for("nodejs.util.promisify.custom"), {
    value: mockExecFileAsync,
    configurable: true,
  });
  return fn;
});
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

const mockWriteFile = vi.hoisted(() => vi.fn());
const mockUnlink = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ writeFile: mockWriteFile, unlink: mockUnlink, rm: mockRm }));

const mockFetch = vi.hoisted(() => vi.fn());

import {
  bbAgent,
  groupThreads,
  paginateAll,
  parseOperationConfig,
  parsePrUrl,
  parseRepoUrl,
  sanitizeDescription,
} from "./agent.ts";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------
const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => mockLogger,
};

const stubPlatformModels = createStubPlatformModels();

function makeContext(env: Record<string, string>) {
  return {
    env,
    logger: mockLogger,
    tools: {},
    session: { sessionId: "test-session", workspaceId: "test-ws" },
    stream: undefined,
    abortSignal: new AbortController().signal,
    platformModels: stubPlatformModels,
  };
}

const BB_ENV = { BITBUCKET_EMAIL: "testuser@bb.org", BITBUCKET_TOKEN: "test-token-abc" };
const PR_URL = "https://bitbucket.org/ws/repo/pull-requests/1";

function jsonPrompt(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/** Mock a successful fetch response returning JSON. */
function jsonResponse(body: unknown): {
  ok: true;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} {
  return {
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** Mock a successful fetch response returning text. */
function textResponse(body: string): { ok: true; text: () => Promise<string> } {
  return { ok: true, text: () => Promise.resolve(body) };
}

/** Mock a failed fetch response. */
function errorResponse(
  status: number,
  statusText: string,
): { ok: false; status: number; statusText: string; text: () => Promise<string> } {
  return { ok: false, status, statusText, text: () => Promise.resolve("") };
}

beforeEach(() => {
  mockClientGET.mockReset();
  mockFetch.mockReset();
  mockExecFileAsync.mockReset();
  mockWriteFile.mockReset();
  mockUnlink.mockReset();
  mockRm.mockReset();
  mockLogger.info.mockReset();
  mockLogger.error.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

// ---------------------------------------------------------------------------
// parsePrUrl
// ---------------------------------------------------------------------------
describe("parsePrUrl", () => {
  test("parses valid Bitbucket PR URL", () => {
    const result = parsePrUrl("https://bitbucket.org/myworkspace/myrepo/pull-requests/42");
    expect(result).toEqual({ workspace: "myworkspace", repo_slug: "myrepo", pr_id: 42 });
  });

  test("parses URL with trailing slash", () => {
    const result = parsePrUrl("https://bitbucket.org/ws/repo/pull-requests/1/");
    expect(result).toEqual({ workspace: "ws", repo_slug: "repo", pr_id: 1 });
  });

  test("throws on wrong hostname", () => {
    expect(() => parsePrUrl("https://github.com/owner/repo/pull/1")).toThrow(
      "Expected bitbucket.org URL",
    );
  });

  test("throws on missing pull-requests segment", () => {
    expect(() => parsePrUrl("https://bitbucket.org/ws/repo/branches")).toThrow(
      "Invalid PR URL path",
    );
  });

  test("throws on non-numeric PR ID", () => {
    expect(() => parsePrUrl("https://bitbucket.org/ws/repo/pull-requests/abc")).toThrow(
      "Invalid PR number in URL",
    );
  });

  test("throws on missing path segments", () => {
    expect(() => parsePrUrl("https://bitbucket.org/ws")).toThrow("Invalid PR URL path");
  });
});

// ---------------------------------------------------------------------------
// parseRepoUrl
// ---------------------------------------------------------------------------
describe("parseRepoUrl", () => {
  test("parses valid Bitbucket repo URL", () => {
    const result = parseRepoUrl("https://bitbucket.org/myworkspace/myrepo");
    expect(result).toEqual({ workspace: "myworkspace", repo_slug: "myrepo" });
  });

  test("parses URL with subpath (e.g. /src/main/)", () => {
    const result = parseRepoUrl(
      "https://bitbucket.org/insanelygreatteam/google_workspace_mcp/src/main/",
    );
    expect(result).toEqual({ workspace: "insanelygreatteam", repo_slug: "google_workspace_mcp" });
  });

  test("throws on wrong hostname", () => {
    expect(() => parseRepoUrl("https://github.com/owner/repo")).toThrow(
      "Expected bitbucket.org URL",
    );
  });

  test("throws on missing repo_slug", () => {
    expect(() => parseRepoUrl("https://bitbucket.org/ws")).toThrow("Invalid repo URL path");
  });
});

// ---------------------------------------------------------------------------
// parseOperationConfig
// ---------------------------------------------------------------------------
describe("parseOperationConfig", () => {
  test("parses JSON block in markdown (code fence path)", () => {
    const prompt = `Some context\n\`\`\`json\n{"operation":"pr-view","pr_url":"${PR_URL}"}\n\`\`\``;
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("pr-view");
  });

  test("parses flat JSON embedded in text (raw extraction path)", () => {
    const prompt = `Execute: {"operation":"pr-diff","pr_url":"${PR_URL}"}`;
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("pr-diff");
  });

  test("parses nested JSON embedded in text (raw extraction path)", () => {
    const json = JSON.stringify({
      operation: "pr-inline-review",
      pr_url: PR_URL,
      verdict: "APPROVE",
      summary: "LGTM",
      findings: [
        {
          severity: "INFO",
          category: "style",
          file: "a.ts",
          line: 1,
          title: "T",
          description: "D",
        },
      ],
    });
    const prompt = `Here is the config: ${json}\nPlease execute.`;
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("pr-inline-review");
    if (config.operation === "pr-inline-review") {
      expect(config.findings).toHaveLength(1);
    }
  });

  test("parses entire prompt as JSON (fallback path)", () => {
    const prompt = `{"operation":"clone","pr_url":"${PR_URL}"}`;
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("clone");
  });

  test("throws on invalid input", () => {
    expect(() => parseOperationConfig("no json here")).toThrow("Could not parse operation config");
  });

  test("parses operation with extra fields", () => {
    const prompt = jsonPrompt({ operation: "pr-review", pr_url: PR_URL, body: "LGTM" });
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("pr-review");
    if (config.operation === "pr-review") {
      expect(config.body).toBe("LGTM");
    }
  });

  test("parses complex operation via code fence (nested JSON)", () => {
    const innerJson = JSON.stringify({
      operation: "pr-inline-review",
      pr_url: PR_URL,
      verdict: "REQUEST_CHANGES",
      summary: "Found issues",
      findings: [
        {
          severity: "CRITICAL",
          category: "security",
          file: "src/auth.ts",
          line: 42,
          title: "SQL injection",
          description: "Unsanitized input",
        },
      ],
    });
    const prompt = `Review this PR:\n\`\`\`json\n${innerJson}\n\`\`\`\nPlease proceed.`;
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("pr-inline-review");
    if (config.operation === "pr-inline-review") {
      expect(config.findings).toHaveLength(1);
      expect(config.verdict).toBe("REQUEST_CHANGES");
    }
  });
});

// ---------------------------------------------------------------------------
// paginateAll
// ---------------------------------------------------------------------------
describe("paginateAll", () => {
  test("returns values from single page", async () => {
    const result = await paginateAll({ values: [1, 2, 3] }, () => {
      throw new Error("should not be called");
    });
    expect(result).toEqual([1, 2, 3]);
  });

  test("follows next URLs across multiple pages", async () => {
    const pages: Record<string, { next?: string; values: number[] }> = {
      page2: { next: "page3", values: [3, 4] },
      page3: { values: [5] },
    };
    const result = await paginateAll({ next: "page2", values: [1, 2] }, (url) =>
      Promise.resolve(pages[url] ?? { values: [] }),
    );
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  test("handles empty first page", async () => {
    const result = await paginateAll({ values: [] }, () => {
      throw new Error("should not be called");
    });
    expect(result).toEqual([]);
  });

  test("handles missing values field", async () => {
    const result = await paginateAll({}, () => {
      throw new Error("should not be called");
    });
    expect(result).toEqual([]);
  });

  test("stops after MAX_PAGES to prevent infinite loops", async () => {
    let calls = 0;
    const result = await paginateAll({ next: "page1", values: [0] }, () => {
      calls++;
      return Promise.resolve({ next: `page${calls + 1}`, values: [calls] });
    });
    // MAX_PAGES is 100, so we get 1 (first page) + 100 (fetched pages) = 101 values
    expect(result).toHaveLength(101);
    expect(calls).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// groupThreads
// ---------------------------------------------------------------------------
describe("groupThreads", () => {
  const BOT = "{bot-uuid}";
  const HUMAN = "{human-uuid}";

  test("returns empty array for no comments", () => {
    expect(groupThreads([], BOT)).toEqual([]);
  });

  test("groups root comment with reply", () => {
    const comments = [
      {
        id: 1,
        content: { raw: "Finding" },
        user: { uuid: BOT },
        inline: { path: "src/a.ts", to: 10 },
      },
      {
        id: 2,
        content: { raw: "Fixed" },
        user: { uuid: HUMAN },
        parent: { id: 1 },
        created_on: "2026-01-01",
      },
    ];
    const threads = groupThreads(comments, BOT);
    expect(threads).toHaveLength(1);
    const [thread] = threads;
    if (!thread) throw new Error("expected thread");
    expect(thread.comment_id).toBe(1);
    expect(thread.path).toBe("src/a.ts");
    expect(thread.line).toBe(10);
    expect(thread.replies).toHaveLength(1);
    const [reply] = thread.replies;
    if (!reply) throw new Error("expected reply");
    expect(reply.body).toBe("Fixed");
  });

  test("filters to bot-authored root comments only", () => {
    const comments = [
      { id: 1, content: { raw: "Bot comment" }, user: { uuid: BOT } },
      { id: 2, content: { raw: "Human comment" }, user: { uuid: HUMAN } },
    ];
    const threads = groupThreads(comments, BOT);
    expect(threads).toHaveLength(1);
    const [thread] = threads;
    if (!thread) throw new Error("expected thread");
    expect(thread.body).toBe("Bot comment");
  });

  test("skips comments with no id", () => {
    const comments = [
      { content: { raw: "No ID" }, user: { uuid: BOT } },
      { id: 1, content: { raw: "Has ID" }, user: { uuid: BOT } },
    ];
    const threads = groupThreads(comments, BOT);
    expect(threads).toHaveLength(1);
    const [thread] = threads;
    if (!thread) throw new Error("expected thread");
    expect(thread.comment_id).toBe(1);
  });

  test("drops orphan replies with no matching root", () => {
    const comments = [
      { id: 1, content: { raw: "Root" }, user: { uuid: BOT } },
      { id: 2, content: { raw: "Orphan" }, user: { uuid: HUMAN }, parent: { id: 999 } },
    ];
    const threads = groupThreads(comments, BOT);
    expect(threads).toHaveLength(1);
    const [thread] = threads;
    if (!thread) throw new Error("expected thread");
    expect(thread.replies).toHaveLength(0);
  });

  test("uses inline.from when inline.to is null", () => {
    const comments = [
      {
        id: 1,
        content: { raw: "Finding" },
        user: { uuid: BOT },
        inline: { path: "a.ts", to: null, from: 5 },
      },
    ];
    const threads = groupThreads(comments, BOT);
    const [thread] = threads;
    if (!thread) throw new Error("expected thread");
    expect(thread.line).toBe(5);
  });

  test("line is undefined when inline is missing", () => {
    const comments = [{ id: 1, content: { raw: "General" }, user: { uuid: BOT } }];
    const threads = groupThreads(comments, BOT);
    const [thread] = threads;
    if (!thread) throw new Error("expected thread");
    expect(thread.line).toBeUndefined();
    expect(thread.path).toBeUndefined();
  });

  test("multiple replies on same thread", () => {
    const comments = [
      { id: 1, content: { raw: "Root" }, user: { uuid: BOT } },
      {
        id: 2,
        content: { raw: "Reply 1" },
        user: { uuid: HUMAN },
        parent: { id: 1 },
        created_on: "2026-01-01",
      },
      {
        id: 3,
        content: { raw: "Reply 2" },
        user: { uuid: BOT },
        parent: { id: 1 },
        created_on: "2026-01-02",
      },
    ];
    const threads = groupThreads(comments, BOT);
    expect(threads).toHaveLength(1);
    const [thread] = threads;
    if (!thread) throw new Error("expected thread");
    expect(thread.replies).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildCommentBody (shared)
// ---------------------------------------------------------------------------
describe("buildCommentBody (shared)", () => {
  test("renders finding without suggestion", () => {
    const body = buildCommentBody({
      severity: "WARNING",
      category: "correctness",
      file: "foo.ts",
      line: 10,
      title: "Missing null check",
      description: "Value may be undefined.",
    });
    expect(body).toContain("**WARNING** — Missing null check");
    expect(body).toContain("**Category:** correctness");
    expect(body).not.toContain("```suggestion");
  });

  test("renders finding with suggestion", () => {
    const body = buildCommentBody({
      severity: "SUGGESTION",
      category: "style",
      file: "bar.ts",
      line: 5,
      title: "Use const",
      description: "Prefer const over let.",
      suggestion: "const x = 1;",
    });
    expect(body).toContain("```suggestion");
    expect(body).toContain("const x = 1;");
  });
});

// ---------------------------------------------------------------------------
// buildFailedFindingsSummary (shared)
// ---------------------------------------------------------------------------
describe("buildFailedFindingsSummary (shared)", () => {
  test("returns empty array for no failures", () => {
    expect(buildFailedFindingsSummary([], [])).toEqual([]);
  });

  test("builds details block for matched finding", () => {
    const findings = [
      {
        severity: "CRITICAL",
        category: "security",
        file: "a.ts",
        line: 10,
        title: "XSS",
        description: "Unescaped",
      },
    ];
    const failed = [{ path: "a.ts", line: 10 }];
    const text = buildFailedFindingsSummary(failed, findings).join("\n");
    expect(text).toContain("<details>");
    expect(text).toContain("CRITICAL");
    expect(text).toContain("a.ts:10");
    expect(text).toContain("</details>");
  });

  test("includes suggestion when present", () => {
    const findings = [
      {
        severity: "WARNING",
        category: "style",
        file: "b.ts",
        line: 5,
        title: "Fix",
        description: "Desc",
        suggestion: "fixed()",
      },
    ];
    const text = buildFailedFindingsSummary([{ path: "b.ts", line: 5 }], findings).join("\n");
    expect(text).toContain("fixed()");
    expect(text).toContain("**Suggestion:**");
  });

  test("skips unmatched failures", () => {
    const findings = [
      {
        severity: "WARNING",
        category: "style",
        file: "a.ts",
        line: 10,
        title: "T",
        description: "D",
      },
    ];
    expect(buildFailedFindingsSummary([{ path: "other.ts", line: 99 }], findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bbAgent handler — error paths
// ---------------------------------------------------------------------------
describe("bbAgent handler — error paths", () => {
  test("returns error when BITBUCKET_EMAIL is missing", async () => {
    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-view", pr_url: PR_URL }),
      makeContext({ BITBUCKET_TOKEN: "tok" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toContain("BITBUCKET_EMAIL");
  });

  test("returns error when BITBUCKET_TOKEN is missing", async () => {
    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-view", pr_url: PR_URL }),
      makeContext({ BITBUCKET_EMAIL: "user" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toContain("BITBUCKET_TOKEN");
  });

  test("returns error on invalid prompt (no JSON)", async () => {
    const result = await bbAgent.execute("just some text with no json", makeContext(BB_ENV));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toContain("Failed to parse operation");
  });

  test("redacts username, token, and base64 credentials in error messages", async () => {
    const username = "testuser@bb.org";
    const token = "xyzzy-secret-42";
    const base64Creds = btoa(`${username}:${token}`);

    // fetchRaw will propagate this error to the outer catch
    mockFetch.mockRejectedValueOnce(
      new Error(`Auth failed: token=${token} creds=${base64Creds} user=${username}`),
    );

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-diff", pr_url: PR_URL }),
      makeContext({ BITBUCKET_EMAIL: username, BITBUCKET_TOKEN: token }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).not.toContain(token);
      expect(result.error.reason).not.toContain(base64Creds);
      expect(result.error.reason).not.toContain(username);
      expect(result.error.reason).toContain("***");
    }
  });
});

// ---------------------------------------------------------------------------
// bbAgent handler — operation happy paths
// ---------------------------------------------------------------------------
describe("bbAgent handler — operations", () => {
  test("pr-view returns error with details when client.GET fails", async () => {
    mockClientGET.mockResolvedValueOnce({
      data: undefined,
      error: { type: "error", error: { message: "Repository not found" } },
    });

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-view", pr_url: PR_URL }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("Failed to fetch PR #1");
      expect(result.error.reason).toContain("Repository not found");
    }
  });

  test("pr-view returns PR metadata", async () => {
    mockClientGET.mockResolvedValueOnce({
      data: {
        title: "Add feature",
        summary: { raw: "Description" },
        author: { display_name: "Author", uuid: "{author}" },
        state: "OPEN",
        source: { branch: { name: "feature" }, commit: { hash: "abc123" } },
        destination: { branch: { name: "main" } },
        created_on: "2026-01-01",
        updated_on: "2026-01-02",
      },
    });

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-view", pr_url: PR_URL }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-view");
      expect(result.data.success).toBe(true);
      expect(result.data.data.title).toBe("Add feature");
      expect(result.data.data.source_branch).toBe("feature");
      expect(result.data.data.head_sha).toBe("abc123");
    }
  });

  test("pr-diff returns raw diff text", async () => {
    const diffText =
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
    mockFetch.mockResolvedValueOnce(textResponse(diffText));

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-diff", pr_url: PR_URL }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-diff");
      expect(result.data.data.diff).toBe(diffText);
    }
  });

  test("pr-diff name_only extracts file paths", async () => {
    const diffText =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts";
    mockFetch.mockResolvedValueOnce(textResponse(diffText));

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-diff", pr_url: PR_URL, name_only: true }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data.diff).toBe("src/a.ts\nsrc/b.ts");
    }
  });

  test("pr-files returns file list from diffstat", async () => {
    mockFetch.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          values: [
            { new: { path: "src/a.ts" }, status: "modified" },
            { old: { path: "src/deleted.ts" }, status: "removed" },
          ],
        }),
      ),
    );

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-files", pr_url: PR_URL }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data.files).toEqual(["src/a.ts", "src/deleted.ts"]);
      expect(result.data.data.count).toBe(2);
    }
  });

  test("pr-files handles null old/new fields for added/deleted files", async () => {
    mockFetch.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          values: [
            { new: { path: "src/added.ts" }, old: null, status: "added" },
            { new: null, old: { path: "src/removed.ts" }, status: "removed" },
          ],
        }),
      ),
    );

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-files", pr_url: PR_URL }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data.files).toEqual(["src/added.ts", "src/removed.ts"]);
      expect(result.data.data.count).toBe(2);
    }
  });

  test("pr-review posts general comment", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 42 }));

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-review", pr_url: PR_URL, body: "Looks good!" }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-review");
      expect(result.data.data.comment_id).toBe(42);
      expect(result.data.data.pr_number).toBe(1);
    }
    // Verify POST was made with correct body
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/pullrequests/1/comments");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body).toEqual({ content: { raw: "Looks good!" } });
  });

  test("pr-inline-review posts inline comments and summary", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: 100 })) // inline comment
      .mockResolvedValueOnce(jsonResponse({ id: 101 })); // summary comment

    const result = await bbAgent.execute(
      jsonPrompt({
        operation: "pr-inline-review",
        pr_url: PR_URL,
        verdict: "APPROVE",
        summary: "Clean code",
        findings: [
          {
            severity: "INFO",
            category: "style",
            file: "a.ts",
            line: 5,
            title: "Nit",
            description: "Minor",
          },
        ],
      }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-inline-review");
      expect(result.data.data.posted_comments).toBe(1);
      expect(result.data.data.failed_comments).toBe(0);
    }
    // Inline comment POST should include inline path/line
    const [, inlineOpts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const inlineBody = JSON.parse(inlineOpts.body as string) as Record<string, unknown>;
    expect(inlineBody).toHaveProperty("inline", { path: "a.ts", to: 5 });
    // Summary comment POST
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("pr-inline-review reports partial failure when some findings fail", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: 100 })) // first finding posts
      .mockResolvedValueOnce(errorResponse(422, "Outside diff range")) // second finding fails
      .mockResolvedValueOnce(jsonResponse({ id: 102 })); // summary comment

    const result = await bbAgent.execute(
      jsonPrompt({
        operation: "pr-inline-review",
        pr_url: PR_URL,
        verdict: "APPROVE",
        summary: "Review",
        findings: [
          {
            severity: "INFO",
            category: "style",
            file: "a.ts",
            line: 5,
            title: "Nit",
            description: "Minor",
          },
          {
            severity: "WARNING",
            category: "correctness",
            file: "b.ts",
            line: 99,
            title: "Bug",
            description: "Oops",
          },
        ],
      }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data.posted_comments).toBe(1);
      expect(result.data.data.failed_comments).toBe(1);
    }
  });

  test("pr-read-threads returns error when /user call fails", async () => {
    mockClientGET.mockResolvedValueOnce({
      data: undefined,
      error: { type: "error", error: { message: "Rate limited" } },
    });

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-read-threads", pr_url: PR_URL }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("Failed to identify bot user");
    }
  });

  test("pr-read-threads groups comments into bot threads", async () => {
    // 1st client.GET: /user
    mockClientGET.mockResolvedValueOnce({ data: { uuid: "{bot}" } });
    // fetch: comments
    mockFetch.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          values: [
            {
              id: 1,
              content: { raw: "Bot finding" },
              user: { uuid: "{bot}" },
              inline: { path: "a.ts", to: 5 },
            },
            {
              id: 2,
              content: { raw: "Human reply" },
              user: { uuid: "{human}" },
              parent: { id: 1 },
              created_on: "2026-01-01",
            },
            { id: 3, content: { raw: "Human comment" }, user: { uuid: "{human}" } },
          ],
        }),
      ),
    );

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "pr-read-threads", pr_url: PR_URL }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-read-threads");
      expect(result.data.data.bot_user).toBe("{bot}");
      expect(result.data.data.total_threads).toBe(1);
      expect(result.data.data.threads_with_replies).toBe(1);
    }
  });

  test("pr-post-followup posts replies and summary", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: 200 })) // thread reply
      .mockResolvedValueOnce(jsonResponse({ id: 201 })); // summary comment

    const result = await bbAgent.execute(
      jsonPrompt({
        operation: "pr-post-followup",
        pr_url: PR_URL,
        thread_replies: [{ comment_id: 100, body: "Fixed" }],
        new_findings: [],
        summary: "Follow-up done",
      }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-post-followup");
      expect(result.data.data.thread_replies_posted).toBe(1);
      expect(result.data.data.new_comments_posted).toBe(0);
    }
  });

  test("pr-post-followup reports success when all replies fail", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(404, "Not Found")) // reply 1 fails
      .mockResolvedValueOnce(errorResponse(500, "Server Error")) // reply 2 fails
      .mockResolvedValueOnce(jsonResponse({ id: 300 })); // summary comment succeeds

    const result = await bbAgent.execute(
      jsonPrompt({
        operation: "pr-post-followup",
        pr_url: PR_URL,
        thread_replies: [
          { comment_id: 100, body: "Fixed" },
          { comment_id: 200, body: "Also fixed" },
        ],
        new_findings: [],
        summary: "Follow-up done",
      }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.success).toBe(true);
      expect(result.data.data.thread_replies_posted).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// parseOperationConfig — repo-clone
// ---------------------------------------------------------------------------
describe("parseOperationConfig — repo-clone", () => {
  test("parses repo-clone operation", () => {
    const config = parseOperationConfig(
      jsonPrompt({ operation: "repo-clone", repo_url: "https://bitbucket.org/ws/repo" }),
    );
    expect(config.operation).toBe("repo-clone");
    if (config.operation === "repo-clone") {
      expect(config.repo_url).toBe("https://bitbucket.org/ws/repo");
      expect(config.branch).toBeUndefined();
    }
  });

  test("parses repo-clone with branch", () => {
    const config = parseOperationConfig(
      jsonPrompt({
        operation: "repo-clone",
        repo_url: "https://bitbucket.org/ws/repo",
        branch: "develop",
      }),
    );
    expect(config.operation).toBe("repo-clone");
    if (config.operation === "repo-clone") {
      expect(config.branch).toBe("develop");
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizeDescription
// ---------------------------------------------------------------------------
describe("sanitizeDescription", () => {
  test("strips markdown badge links", () => {
    const input =
      "Before [![Build](https://img.shields.io/badge.svg)](https://ci.example.com) after";
    expect(sanitizeDescription(input)).toBe("Before  after");
  });

  test("strips inline images", () => {
    const input = "See ![screenshot](https://example.com/img.png) here";
    expect(sanitizeDescription(input)).toBe("See  here");
  });

  test("preserves regular markdown links", () => {
    const input = "See [PR #42](https://bitbucket.org/ws/repo/pull-requests/42)";
    expect(sanitizeDescription(input)).toBe(
      "See [PR #42](https://bitbucket.org/ws/repo/pull-requests/42)",
    );
  });

  test("collapses multiple blank lines after stripping", () => {
    const input = "Before\n\n\n\n\nAfter";
    expect(sanitizeDescription(input)).toBe("Before\n\nAfter");
  });

  test("passes through plain text unchanged", () => {
    expect(sanitizeDescription("Simple description")).toBe("Simple description");
  });

  test("returns empty string for empty input", () => {
    expect(sanitizeDescription("")).toBe("");
  });

  test("strips image with empty alt text", () => {
    expect(sanitizeDescription("Before ![](https://img.png) after")).toBe("Before  after");
  });

  test("returns empty string when description becomes empty after stripping", () => {
    expect(sanitizeDescription("![img](url)")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// bbAgent handler — clone operation
// ---------------------------------------------------------------------------
describe("bbAgent handler — clone", () => {
  const PR_METADATA = {
    title: "Add feature",
    summary: { raw: "Description" },
    author: { display_name: "Author" },
    state: "OPEN",
    source: { branch: { name: "feature/cool" }, commit: { hash: "abc123def" } },
    destination: { branch: { name: "main" } },
  };

  const DIFFSTAT_RESPONSE = {
    values: [
      { new: { path: "src/new-file.ts" }, status: "added" },
      { new: { path: "src/changed.ts" }, old: { path: "src/changed.ts" }, status: "modified" },
    ],
  };

  test("clones repo, checks out branch, and returns file list", async () => {
    // client.GET: PR metadata
    mockClientGET.mockResolvedValueOnce({ data: PR_METADATA });
    // writeFile: askpass script (no-op)
    mockWriteFile.mockResolvedValue(undefined);
    // execFileAsync: git clone, git checkout, git branch --show-current
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "feature/cool", stderr: "" });
    // unlink: askpass cleanup (no-op)
    mockUnlink.mockResolvedValue(undefined);
    // fetch: diffstat
    mockFetch.mockResolvedValueOnce(textResponse(JSON.stringify(DIFFSTAT_RESPONSE)));

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "clone", pr_url: PR_URL }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("clone");
      expect(result.data.success).toBe(true);
      expect(result.data.data.branch).toBe("feature/cool");
      expect(result.data.data.base_branch).toBe("main");
      expect(result.data.data.pr_number).toBe(1);
      expect(result.data.data.head_sha).toBe("abc123def");
      expect(result.data.data.changed_files).toEqual(["src/new-file.ts", "src/changed.ts"]);
      expect(result.data.data.pr_metadata).toMatchObject({
        title: "Add feature",
        author: "Author",
        state: "OPEN",
      });
      // Clone path should be a temp directory
      expect(result.data.data.path).toMatch(/bb-clone-/);
    }
  });

  test("uses GIT_ASKPASS for credentials, not token in clone URL", async () => {
    mockClientGET.mockResolvedValueOnce({ data: PR_METADATA });
    mockWriteFile.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: "feature/cool", stderr: "" });
    mockUnlink.mockResolvedValue(undefined);
    mockFetch.mockResolvedValueOnce(textResponse(JSON.stringify(DIFFSTAT_RESPONSE)));

    await bbAgent.execute(jsonPrompt({ operation: "clone", pr_url: PR_URL }), makeContext(BB_ENV));

    // First execFileAsync call is git clone — verify env vars
    const cloneCall = mockExecFileAsync.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    const cloneArgs = cloneCall[1];
    const cloneOpts = cloneCall[2] as { env: Record<string, string> };

    // Clone URL should NOT contain the token
    const cloneUrlArg = cloneArgs.find((a: string) => a.includes("bitbucket.org"));
    expect(cloneUrlArg).toBeDefined();
    expect(cloneUrlArg).not.toContain(BB_ENV.BITBUCKET_TOKEN);

    // GIT_ASKPASS should be set to the askpass script path
    expect(cloneOpts.env.GIT_ASKPASS).toMatch(/bb-askpass-/);
    expect(cloneOpts.env.GIT_TERMINAL_PROMPT).toBe("0");
    // Askpass creds use api-token-auth username, not the user's email
    expect(cloneOpts.env.BB_ASKPASS_USER).toBe("x-bitbucket-api-token-auth");
    expect(cloneOpts.env.BB_ASKPASS_PASS).toBe(BB_ENV.BITBUCKET_TOKEN);
  });

  test("clone returns error when PR metadata fetch fails", async () => {
    mockClientGET.mockResolvedValueOnce({
      data: undefined,
      error: { type: "error", error: { message: "Not Found" } },
    });

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "clone", pr_url: PR_URL }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("Failed to fetch PR #1");
    }
  });
});

// ---------------------------------------------------------------------------
// bbAgent handler — repo-clone
// ---------------------------------------------------------------------------
describe("bbAgent handler — repo-clone", () => {
  test("repo-clone returns path, repo, and branch", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "main\n", stderr: "" });
    mockWriteFile.mockImplementation(() => Promise.resolve());
    mockUnlink.mockImplementation(() => Promise.resolve());

    const result = await bbAgent.execute(
      jsonPrompt({ operation: "repo-clone", repo_url: "https://bitbucket.org/ws/repo" }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("repo-clone");
      expect(result.data.success).toBe(true);
      expect(result.data.data.repo).toBe("ws/repo");
      expect(result.data.data.branch).toBe("main");
      expect(typeof result.data.data.path).toBe("string");
    }
  });

  test("repo-clone with branch parameter checks out specified branch", async () => {
    const execCalls: [string, string[]][] = [];
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      execCalls.push([cmd, args]);
      return Promise.resolve({ stdout: "develop\n", stderr: "" });
    });
    mockWriteFile.mockImplementation(() => Promise.resolve());
    mockUnlink.mockImplementation(() => Promise.resolve());

    const result = await bbAgent.execute(
      jsonPrompt({
        operation: "repo-clone",
        repo_url: "https://bitbucket.org/ws/repo",
        branch: "develop",
      }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data.branch).toBe("develop");
    }

    // Verify checkout was called with the branch name
    const checkoutCall = execCalls.find(([, args]) => args[0] === "checkout");
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall?.[1]).toContain("develop");
  });
});

// ---------------------------------------------------------------------------
// bbAgent handler — pr-create
// ---------------------------------------------------------------------------
describe("bbAgent handler — pr-create", () => {
  const REPO_URL = "https://bitbucket.org/ws/repo";

  test("pr-create creates a pull request", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        id: 42,
        links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/42" } },
      }),
    );

    const result = await bbAgent.execute(
      jsonPrompt({
        operation: "pr-create",
        repo_url: REPO_URL,
        source_branch: "feature/fix-bug",
        title: "Fix the bug",
        description: "Fixes issue #123",
      }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-create");
      expect(result.data.data.pr_number).toBe(42);
      expect(result.data.data.pr_url).toBe("https://bitbucket.org/ws/repo/pull-requests/42");
      expect(result.data.data.source_branch).toBe("feature/fix-bug");
      expect(result.data.data.destination_branch).toBe("main");
    }

    // Verify POST body
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/repositories/ws/repo/pullrequests");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      title: "Fix the bug",
      description: "Fixes issue #123",
      source: { branch: { name: "feature/fix-bug" } },
      destination: { branch: { name: "main" } },
    });
  });

  test("pr-create uses custom destination branch", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 7 }));

    const result = await bbAgent.execute(
      jsonPrompt({
        operation: "pr-create",
        repo_url: REPO_URL,
        source_branch: "hotfix/urgent",
        destination_branch: "develop",
        title: "Hotfix",
        close_source_branch: true,
      }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data.destination_branch).toBe("develop");
    }

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body).toHaveProperty("close_source_branch", true);
    expect(body).toHaveProperty("destination", { branch: { name: "develop" } });
  });

  test("pr-create returns error on API failure", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(400, "Bad Request"));

    const result = await bbAgent.execute(
      jsonPrompt({
        operation: "pr-create",
        repo_url: REPO_URL,
        source_branch: "feature/x",
        title: "Test",
      }),
      makeContext(BB_ENV),
    );

    expect(result.ok).toBe(false);
  });

  test("pr-create with only issue_key builds description with Fixes header", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 42 }));

    await bbAgent.execute(
      jsonPrompt({
        operation: "pr-create",
        repo_url: REPO_URL,
        source_branch: "fix/dev-4",
        title: "DEV-4: Fix",
        issue_key: "DEV-4",
      }),
      makeContext(BB_ENV),
    );

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(typeof body.description).toBe("string");
    expect(body.description as string).toContain("Fixes DEV-4");
  });

  test("pr-create with only summary builds description with summary text", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 42 }));

    await bbAgent.execute(
      jsonPrompt({
        operation: "pr-create",
        repo_url: REPO_URL,
        source_branch: "fix/badge",
        title: "Add badge",
        summary: "Added missing PyPI badge to README",
      }),
      makeContext(BB_ENV),
    );

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(typeof body.description).toBe("string");
    expect(body.description as string).toContain("Added missing PyPI badge to README");
  });

  test("pr-create with all structured fields builds complete description", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 42 }));

    await bbAgent.execute(
      jsonPrompt({
        operation: "pr-create",
        repo_url: REPO_URL,
        source_branch: "fix/dev-4",
        title: "DEV-4: Fix the bug",
        issue_key: "DEV-4",
        summary: "Added missing badge",
        files_changed: ["README.md", "setup.cfg"],
      }),
      makeContext(BB_ENV),
    );

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    const desc = body.description as string;
    expect(desc).toContain("Fixes DEV-4");
    expect(desc).toContain("Added missing badge");
    expect(desc).toContain("- README.md");
    expect(desc).toContain("- setup.cfg");
  });
});

// ---------------------------------------------------------------------------
// bbAgent metadata
// ---------------------------------------------------------------------------
describe("bbAgent metadata", () => {
  test("has correct id and constructs without error", () => {
    expect(bbAgent.metadata.id).toBe("bb");
  });

  test("has linkRef for both env vars", () => {
    const required = bbAgent.environmentConfig?.required ?? [];
    const emailEnv = required.find((r) => r.name === "BITBUCKET_EMAIL");
    const tokenEnv = required.find((r) => r.name === "BITBUCKET_TOKEN");
    expect(emailEnv?.linkRef).toEqual({ provider: "bitbucket", key: "email" });
    expect(tokenEnv?.linkRef).toEqual({ provider: "bitbucket", key: "app_password" });
  });
});
