import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports)
// ---------------------------------------------------------------------------
const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

const mockMkdtemp = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockUnlink = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
  mkdtemp: mockMkdtemp,
  writeFile: mockWriteFile,
  unlink: mockUnlink,
  rm: mockRm,
}));

import { ghAgent } from "./agent.ts";

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

function makeContext(env: Record<string, string>) {
  return {
    env,
    logger: mockLogger,
    tools: {},
    session: { sessionId: "test-session", workspaceId: "test-ws" },
    stream: undefined,
  };
}

const GH_ENV = { GH_TOKEN: "ghp_test-token-abc123" };
const PR_URL = "https://github.com/owner/repo/pull/1";

function jsonPrompt(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/**
 * Set up execFile mock to behave like promisify(execFile): callback-based.
 * Returns `stdout` for every invocation.
 */
function setupExecFileMock(stdout: string) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: (err: null, result: { stdout: string }) => void,
    ) => {
      callback(null, { stdout: `${stdout}\n` });
    },
  );
}

/**
 * Set up execFile mock that returns different values based on call index.
 */
function setupExecFileSequence(outputs: string[]) {
  let callIndex = 0;
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: (err: null, result: { stdout: string }) => void,
    ) => {
      const idx = callIndex++;
      const stdout = outputs[idx] ?? "";
      callback(null, { stdout: `${stdout}\n` });
    },
  );
}

beforeEach(() => {
  mockExecFile.mockReset();
  mockMkdtemp.mockReset();
  mockWriteFile.mockReset();
  mockUnlink.mockReset();
  mockRm.mockReset();
  mockLogger.info.mockReset();
  mockLogger.error.mockReset();
});

// ---------------------------------------------------------------------------
// parseOperationConfig (tested via ghAgent since it's not exported)
// ---------------------------------------------------------------------------
describe("parseOperationConfig via ghAgent", () => {
  test("parses valid JSON prompt", async () => {
    setupExecFileMock("file1.ts\nfile2.ts");
    const result = await ghAgent.execute(
      jsonPrompt({ operation: "pr-files", pr_url: PR_URL }),
      makeContext(GH_ENV),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-files");
    }
  });

  test("returns error on invalid input (no JSON)", async () => {
    const result = await ghAgent.execute("no json here at all", makeContext(GH_ENV));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("Failed to parse operation");
    }
  });

  test("parses JSON in code fence", async () => {
    setupExecFileMock("src/a.ts");
    const prompt = `Review this:\n\`\`\`json\n{"operation":"pr-files","pr_url":"${PR_URL}"}\n\`\`\``;
    const result = await ghAgent.execute(prompt, makeContext(GH_ENV));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-files");
    }
  });
});

// ---------------------------------------------------------------------------
// ghAgent handler — error paths
// ---------------------------------------------------------------------------
describe("ghAgent handler — error paths", () => {
  test("returns error when GH_TOKEN is missing", async () => {
    const result = await ghAgent.execute(
      jsonPrompt({ operation: "pr-view", pr_url: PR_URL }),
      makeContext({}),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("GH_TOKEN");
    }
  });

  test("returns error on invalid prompt (no JSON)", async () => {
    const result = await ghAgent.execute("just some text with no json", makeContext(GH_ENV));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("Failed to parse operation");
    }
  });

  test("redacts token and base64 credentials in error messages", async () => {
    const token = "ghp_xyzzy-secret-42";
    const base64Creds = btoa(`x-access-token:${token}`);

    // Make execFile throw an error containing the token
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: Record<string, unknown>,
        callback: (err: Error) => void,
      ) => {
        callback(new Error(`Auth failed: token=${token} creds=${base64Creds}`));
      },
    );

    const result = await ghAgent.execute(
      jsonPrompt({ operation: "pr-diff", pr_url: PR_URL }),
      makeContext({ GH_TOKEN: token }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).not.toContain(token);
      expect(result.error.reason).not.toContain(base64Creds);
      expect(result.error.reason).toContain("***");
    }
  });
});

// ---------------------------------------------------------------------------
// ghAgent handler — pr-view
// ---------------------------------------------------------------------------
describe("ghAgent handler — pr-view", () => {
  test("returns PR metadata", async () => {
    const metadata = {
      title: "Add feature",
      body: "Description",
      author: { login: "testuser" },
      baseRefName: "main",
      headRefName: "feature",
      additions: 10,
      deletions: 5,
      changedFiles: 2,
    };
    setupExecFileMock(JSON.stringify(metadata));

    const result = await ghAgent.execute(
      jsonPrompt({ operation: "pr-view", pr_url: PR_URL }),
      makeContext(GH_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-view");
      expect(result.data.success).toBe(true);
      expect(result.data.data.title).toBe("Add feature");
      expect(result.data.data.baseRefName).toBe("main");
    }
  });
});

// ---------------------------------------------------------------------------
// ghAgent handler — pr-diff
// ---------------------------------------------------------------------------
describe("ghAgent handler — pr-diff", () => {
  test("returns raw diff text", async () => {
    const diffText =
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
    setupExecFileMock(diffText);

    const result = await ghAgent.execute(
      jsonPrompt({ operation: "pr-diff", pr_url: PR_URL }),
      makeContext(GH_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-diff");
      expect(result.data.data.diff).toBe(diffText);
    }
  });
});

// ---------------------------------------------------------------------------
// ghAgent handler — pr-files
// ---------------------------------------------------------------------------
describe("ghAgent handler — pr-files", () => {
  test("returns file list", async () => {
    setupExecFileMock("src/auth.ts\nsrc/login.ts");

    const result = await ghAgent.execute(
      jsonPrompt({ operation: "pr-files", pr_url: PR_URL }),
      makeContext(GH_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-files");
      expect(result.data.data.files).toEqual(["src/auth.ts", "src/login.ts"]);
      expect(result.data.data.count).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// ghAgent handler — pr-review
// ---------------------------------------------------------------------------
describe("ghAgent handler — pr-review", () => {
  test("posts review and returns review URL", async () => {
    mockMkdtemp.mockImplementation(() => Promise.resolve("/tmp/gh-review-test"));
    mockWriteFile.mockImplementation(() => Promise.resolve());
    mockUnlink.mockImplementation(() => Promise.resolve());

    // First call: gh pr review (post), second call: gh pr view --json reviews (verify)
    setupExecFileSequence(["", "https://github.com/owner/repo/pull/1#pullrequestreview-123"]);

    const result = await ghAgent.execute(
      jsonPrompt({ operation: "pr-review", pr_url: PR_URL, body: "LGTM" }),
      makeContext(GH_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-review");
      expect(result.data.data.pr_number).toBe(1);
      expect(result.data.data.repo).toBe("owner/repo");
      expect(typeof result.data.data.review_url).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// ghAgent handler — clone
// ---------------------------------------------------------------------------
describe("ghAgent handler — clone", () => {
  test("returns path, branch, and changed_files", async () => {
    // Calls: gh repo clone, gh pr checkout, git branch, gh pr view, gh pr diff --name-only
    const prMetadata = JSON.stringify({
      title: "Add feature",
      baseRefName: "main",
      headRefName: "feature/auth",
      headRefOid: "abc123",
    });
    setupExecFileSequence([
      "", // gh repo clone
      "", // gh pr checkout
      "feature/auth", // git branch --show-current
      prMetadata, // gh pr view --json
      "src/auth.ts\nsrc/login.ts", // gh pr diff --name-only
    ]);

    const result = await ghAgent.execute(
      jsonPrompt({ operation: "clone", pr_url: PR_URL }),
      makeContext(GH_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("clone");
      expect(result.data.success).toBe(true);
      expect(result.data.data.branch).toBe("feature/auth");
      expect(result.data.data.head_sha).toBe("abc123");
      expect(result.data.data.changed_files).toEqual(["src/auth.ts", "src/login.ts"]);
      expect(typeof result.data.data.path).toBe("string");
    }
  });

  test("cleans up temp dir on clone failure", async () => {
    mockRm.mockImplementation(() => Promise.resolve());

    // Make the first execFile call (gh repo clone) fail
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: Record<string, unknown>,
        callback: (err: Error) => void,
      ) => {
        callback(new Error("clone failed: repository not found"));
      },
    );

    const result = await ghAgent.execute(
      jsonPrompt({ operation: "clone", pr_url: PR_URL }),
      makeContext(GH_ENV),
    );

    expect(result.ok).toBe(false);
    // Verify rm was called for cleanup
    expect(mockRm).toHaveBeenCalledOnce();
    const [rmPath, rmOpts] = mockRm.mock.calls[0] as [
      string,
      { recursive: boolean; force: boolean },
    ];
    expect(rmPath).toContain("gh-clone-");
    expect(rmOpts).toEqual({ recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// ghAgent handler — pr-inline-review
// ---------------------------------------------------------------------------
describe("ghAgent handler — pr-inline-review", () => {
  test("posts inline comments and summary", async () => {
    mockMkdtemp.mockImplementation(() => Promise.resolve("/tmp/gh-review-test"));
    mockWriteFile.mockImplementation(() => Promise.resolve());
    mockUnlink.mockImplementation(() => Promise.resolve());

    // Calls: gh api (inline comment), gh pr review (summary), gh unlink cleanup
    setupExecFileSequence([
      "", // gh api (inline comment)
      "", // gh pr review (summary)
    ]);

    const result = await ghAgent.execute(
      jsonPrompt({
        operation: "pr-inline-review",
        pr_url: PR_URL,
        commit_id: "abc123",
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
      makeContext(GH_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-inline-review");
      expect(result.data.data.posted_comments).toBe(1);
      expect(result.data.data.failed_comments).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ghAgent handler — pr-read-threads
// ---------------------------------------------------------------------------
describe("ghAgent handler — pr-read-threads", () => {
  test("groups comments into bot threads", async () => {
    const comments = [
      {
        id: 1,
        in_reply_to_id: null,
        user: { login: "friday-bot" },
        body: "Bot finding",
        path: "src/a.ts",
        line: 10,
        original_line: 10,
        created_at: "2026-01-01",
      },
      {
        id: 2,
        in_reply_to_id: 1,
        user: { login: "human" },
        body: "Fixed it",
        path: "src/a.ts",
        line: 10,
        original_line: 10,
        created_at: "2026-01-02",
      },
      {
        id: 3,
        in_reply_to_id: null,
        user: { login: "human" },
        body: "Human comment",
        path: "src/b.ts",
        line: 5,
        original_line: 5,
        created_at: "2026-01-01",
      },
    ];

    // First call: gh api user, second call: gh api comments
    setupExecFileSequence(["friday-bot", JSON.stringify(comments)]);

    const result = await ghAgent.execute(
      jsonPrompt({ operation: "pr-read-threads", pr_url: PR_URL }),
      makeContext(GH_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-read-threads");
      expect(result.data.data.bot_user).toBe("friday-bot");
      expect(result.data.data.total_threads).toBe(1);
      expect(result.data.data.threads_with_replies).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// ghAgent handler — pr-post-followup
// ---------------------------------------------------------------------------
describe("ghAgent handler — pr-post-followup", () => {
  test("posts replies and summary", async () => {
    mockMkdtemp.mockImplementation(() => Promise.resolve("/tmp/gh-review-test"));
    mockWriteFile.mockImplementation(() => Promise.resolve());
    mockUnlink.mockImplementation(() => Promise.resolve());

    // Calls: gh api (thread reply), gh pr review (summary)
    setupExecFileSequence([
      "", // gh api (thread reply)
      "", // gh pr review (summary)
    ]);

    const result = await ghAgent.execute(
      jsonPrompt({
        operation: "pr-post-followup",
        pr_url: PR_URL,
        commit_id: "abc123",
        thread_replies: [{ comment_id: 100, body: "Fixed" }],
        new_findings: [],
        summary: "Follow-up done",
      }),
      makeContext(GH_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("pr-post-followup");
      expect(result.data.data.thread_replies_posted).toBe(1);
      expect(result.data.data.new_comments_posted).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ghAgent metadata
// ---------------------------------------------------------------------------
describe("ghAgent metadata", () => {
  test("has correct id", () => {
    expect(ghAgent.metadata.id).toBe("gh");
  });

  test("has linkRef for GH_TOKEN", () => {
    const required = ghAgent.environmentConfig?.required ?? [];
    const tokenEnv = required.find((r) => r.name === "GH_TOKEN");
    expect(tokenEnv?.linkRef).toEqual({ provider: "github", key: "access_token" });
  });

  test("has structured XML description", () => {
    const desc = ghAgent.metadata.description;
    expect(desc).toContain("<role>");
    expect(desc).toContain("<operations>");
    expect(desc).toContain("<error_handling>");
  });
});
