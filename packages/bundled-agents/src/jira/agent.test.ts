import { createStubPlatformModels } from "@atlas/llm";
import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock jira.js Version3Client
// ---------------------------------------------------------------------------

const mockGetIssue = vi.hoisted(() => vi.fn());
const mockSearchForIssuesUsingJqlEnhancedSearch = vi.hoisted(() => vi.fn());
const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
const mockGetTransitions = vi.hoisted(() => vi.fn());
const mockDoTransition = vi.hoisted(() => vi.fn());
const mockAddComment = vi.hoisted(() => vi.fn());

vi.mock("jira.js", () => ({
  Version3Client: class MockVersion3Client {
    issues = {
      getIssue: mockGetIssue,
      createIssue: mockCreateIssue,
      editIssue: mockEditIssue,
      getTransitions: mockGetTransitions,
      doTransition: mockDoTransition,
    };
    issueSearch = {
      searchForIssuesUsingJqlEnhancedSearch: mockSearchForIssuesUsingJqlEnhancedSearch,
    };
    issueComments = { addComment: mockAddComment };
  },
}));

import {
  buildBaseUrl,
  extractAdfText,
  jiraAgent,
  parseOperationConfig,
  textToAdfContent,
} from "./agent.ts";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
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

const JIRA_ENV = {
  JIRA_EMAIL: "user@acme.com",
  JIRA_API_TOKEN: "test-jira-token-abc",
  JIRA_SITE: "acme.atlassian.net",
};

function jsonPrompt(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

beforeEach(() => {
  mockGetIssue.mockReset();
  mockSearchForIssuesUsingJqlEnhancedSearch.mockReset();
  mockCreateIssue.mockReset();
  mockEditIssue.mockReset();
  mockGetTransitions.mockReset();
  mockDoTransition.mockReset();
  mockAddComment.mockReset();
  mockLogger.info.mockReset();
  mockLogger.error.mockReset();
});

// ---------------------------------------------------------------------------
// buildBaseUrl
// ---------------------------------------------------------------------------
describe("buildBaseUrl", () => {
  test("converts bare hostname to HTTPS URL", () => {
    expect(buildBaseUrl("acme.atlassian.net")).toBe("https://acme.atlassian.net");
  });

  test("normalizes https URL to just scheme + host", () => {
    expect(buildBaseUrl("https://acme.atlassian.net/some/path")).toBe("https://acme.atlassian.net");
  });

  test("upgrades http to https", () => {
    expect(buildBaseUrl("http://acme.atlassian.net")).toBe("https://acme.atlassian.net");
  });

  test("trims whitespace", () => {
    expect(buildBaseUrl("  acme.atlassian.net  ")).toBe("https://acme.atlassian.net");
  });
});

// ---------------------------------------------------------------------------
// extractAdfText
// ---------------------------------------------------------------------------
describe("extractAdfText", () => {
  test("returns empty string for null/undefined", () => {
    expect(extractAdfText(null)).toBe("");
    expect(extractAdfText(undefined)).toBe("");
  });

  test("extracts text from simple ADF document", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
    };
    expect(extractAdfText(adf)).toBe("Hello world");
  });

  test("concatenates text from multiple paragraphs", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second." }] },
      ],
    };
    expect(extractAdfText(adf)).toBe("First.Second.");
  });

  test("handles deeply nested content", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "item 1" }] }],
            },
          ],
        },
      ],
    };
    expect(extractAdfText(adf)).toBe("item 1");
  });

  test("returns empty string for non-object", () => {
    expect(extractAdfText("hello")).toBe("");
    expect(extractAdfText(42)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// textToAdfContent
// ---------------------------------------------------------------------------
describe("textToAdfContent", () => {
  test("plain text becomes a single text node", () => {
    expect(textToAdfContent("Hello world")).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("markdown link becomes text node with link mark", () => {
    expect(textToAdfContent("[Click here](https://example.com)")).toEqual([
      {
        type: "text",
        text: "Click here",
        marks: [{ type: "link", attrs: { href: "https://example.com" } }],
      },
    ]);
  });

  test("text with inline link splits into three nodes", () => {
    const result = textToAdfContent("PR created: [PR #42](https://bb.org/pr/42) by Friday");
    expect(result).toEqual([
      { type: "text", text: "PR created: " },
      {
        type: "text",
        text: "PR #42",
        marks: [{ type: "link", attrs: { href: "https://bb.org/pr/42" } }],
      },
      { type: "text", text: " by Friday" },
    ]);
  });

  test("multiple links in one string", () => {
    const result = textToAdfContent("[A](https://a.com) and [B](https://b.com)");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      type: "text",
      text: "A",
      marks: [{ type: "link", attrs: { href: "https://a.com" } }],
    });
    expect(result[1]).toEqual({ type: "text", text: " and " });
    expect(result[2]).toEqual({
      type: "text",
      text: "B",
      marks: [{ type: "link", attrs: { href: "https://b.com" } }],
    });
  });

  test("empty string returns single text node", () => {
    expect(textToAdfContent("")).toEqual([{ type: "text", text: "" }]);
  });
});

// ---------------------------------------------------------------------------
// parseOperationConfig
// ---------------------------------------------------------------------------
describe("parseOperationConfig", () => {
  test("parses JSON block in markdown (code fence path)", () => {
    const prompt = `Some context\n\`\`\`json\n{"operation":"issue-view","issue_key":"PROJ-123"}\n\`\`\``;
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("issue-view");
  });

  test("parses flat JSON embedded in text (raw extraction path)", () => {
    const prompt = `Execute: {"operation":"issue-search","jql":"project = PROJ"}`;
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("issue-search");
  });

  test("parses entire prompt as JSON (fallback path)", () => {
    const prompt = `{"operation":"issue-view","issue_key":"PROJ-1"}`;
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("issue-view");
  });

  test("throws on invalid input", () => {
    expect(() => parseOperationConfig("no json here")).toThrow("Could not parse operation config");
  });

  test("parses issue-create with all fields", () => {
    const prompt = jsonPrompt({
      operation: "issue-create",
      project_key: "PROJ",
      summary: "Bug title",
      description: "Bug description",
      issue_type: "Task",
      labels: ["frontend"],
      priority: "High",
    });
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("issue-create");
    if (config.operation === "issue-create") {
      expect(config.project_key).toBe("PROJ");
      expect(config.labels).toEqual(["frontend"]);
      expect(config.priority).toBe("High");
    }
  });

  test("parses issue-update with partial fields", () => {
    const prompt = jsonPrompt({
      operation: "issue-update",
      issue_key: "PROJ-99",
      summary: "Updated title",
    });
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("issue-update");
    if (config.operation === "issue-update") {
      expect(config.issue_key).toBe("PROJ-99");
      expect(config.summary).toBe("Updated title");
    }
  });

  test("parses issue-transition", () => {
    const prompt = jsonPrompt({
      operation: "issue-transition",
      issue_key: "PROJ-5",
      transition_name: "Done",
    });
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("issue-transition");
  });

  test("parses issue-comment", () => {
    const prompt = jsonPrompt({
      operation: "issue-comment",
      issue_key: "PROJ-5",
      body: "This is a comment",
    });
    const config = parseOperationConfig(prompt);
    expect(config.operation).toBe("issue-comment");
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — error paths
// ---------------------------------------------------------------------------
describe("jiraAgent handler — error paths", () => {
  test("returns error when JIRA_EMAIL is missing", async () => {
    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-view", issue_key: "PROJ-1" }),
      makeContext({ JIRA_API_TOKEN: "tok", JIRA_SITE: "acme.atlassian.net" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toContain("JIRA_EMAIL");
  });

  test("returns error when JIRA_API_TOKEN is missing", async () => {
    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-view", issue_key: "PROJ-1" }),
      makeContext({ JIRA_EMAIL: "user@acme.com", JIRA_SITE: "acme.atlassian.net" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toContain("JIRA_API_TOKEN");
  });

  test("returns error when JIRA_SITE is missing", async () => {
    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-view", issue_key: "PROJ-1" }),
      makeContext({ JIRA_EMAIL: "user@acme.com", JIRA_API_TOKEN: "tok" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toContain("JIRA_SITE");
  });

  test("returns error on invalid prompt (no JSON)", async () => {
    const result = await jiraAgent.execute("just some text with no json", makeContext(JIRA_ENV));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toContain("Failed to parse operation");
  });

  test("redacts email, token, and base64 credentials in error messages", async () => {
    const email = "user@acme.com";
    const token = "xyzzy-secret-42";
    const base64Creds = btoa(`${email}:${token}`);

    mockGetIssue.mockRejectedValueOnce(
      new Error(`Auth failed: token=${token} creds=${base64Creds} user=${email}`),
    );

    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-view", issue_key: "PROJ-1" }),
      makeContext({ JIRA_EMAIL: email, JIRA_API_TOKEN: token, JIRA_SITE: "acme.atlassian.net" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).not.toContain(token);
      expect(result.error.reason).not.toContain(base64Creds);
      expect(result.error.reason).not.toContain(email);
      expect(result.error.reason).toContain("***");
    }
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-view
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-view", () => {
  test("returns issue data on success", async () => {
    mockGetIssue.mockResolvedValueOnce({
      key: "PROJ-123",
      id: "10001",
      self: "https://acme.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Fix login bug",
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Login fails on mobile" }] },
          ],
        },
        status: { name: "In Progress" },
        priority: { name: "High" },
        labels: ["bug", "frontend"],
        assignee: { displayName: "Alice", accountId: "abc" },
        reporter: { displayName: "Bob", accountId: "def" },
        issuetype: { name: "Bug" },
        created: "2026-01-01T00:00:00.000+0000",
        updated: "2026-01-02T00:00:00.000+0000",
      },
    });

    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-view", issue_key: "PROJ-123" }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("issue-view");
      expect(result.data.success).toBe(true);
      expect(result.data.data.key).toBe("PROJ-123");
      expect(result.data.data.summary).toBe("Fix login bug");
      expect(result.data.data.description).toBe("Login fails on mobile");
      expect(result.data.data.status).toBe("In Progress");
      expect(result.data.data.priority).toBe("High");
      expect(result.data.data.labels).toEqual(["bug", "frontend"]);
      expect(result.data.data.assignee).toBe("Alice");
      expect(result.data.data.reporter).toBe("Bob");
    }

    // Verify client method was called with correct params
    expect(mockGetIssue).toHaveBeenCalledOnce();
    expect(mockGetIssue).toHaveBeenCalledWith({ issueIdOrKey: "PROJ-123" });
  });

  test("returns error on API failure", async () => {
    mockGetIssue.mockRejectedValueOnce(new Error("Request failed with status code 404"));

    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-view", issue_key: "PROJ-999" }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("jira issue-view failed");
      expect(result.error.reason).toContain("404");
    }
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-search
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-search", () => {
  test("returns search results", async () => {
    mockSearchForIssuesUsingJqlEnhancedSearch.mockResolvedValueOnce({
      issues: [
        {
          key: "PROJ-1",
          id: "10001",
          self: "https://acme.atlassian.net/rest/api/3/issue/10001",
          fields: {
            summary: "Issue 1",
            status: { name: "Open" },
            priority: { name: "Medium" },
            labels: [],
          },
        },
        {
          key: "PROJ-2",
          id: "10002",
          self: "https://acme.atlassian.net/rest/api/3/issue/10002",
          fields: {
            summary: "Issue 2",
            status: { name: "Done" },
            priority: { name: "Low" },
            labels: ["backend"],
          },
        },
      ],
      total: 2,
      maxResults: 50,
      startAt: 0,
    });

    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-search", jql: "project = PROJ" }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("issue-search");
      const issues = result.data.data.issues as Array<Record<string, unknown>>;
      expect(issues).toHaveLength(2);
      expect(issues.at(0)?.key).toBe("PROJ-1");
      expect(issues.at(1)?.key).toBe("PROJ-2");
      expect(result.data.data.total).toBe(2);
    }

    // Verify search was called with correct params
    expect(mockSearchForIssuesUsingJqlEnhancedSearch).toHaveBeenCalledWith({
      jql: "project = PROJ",
      maxResults: 50,
      fields: expect.arrayContaining(["summary", "status", "labels"]),
    });
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-create
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-create", () => {
  test("creates an issue and returns key/id/self", async () => {
    mockCreateIssue.mockResolvedValueOnce({
      id: "10042",
      key: "PROJ-42",
      self: "https://acme.atlassian.net/rest/api/3/issue/10042",
    });

    const result = await jiraAgent.execute(
      jsonPrompt({
        operation: "issue-create",
        project_key: "PROJ",
        summary: "New bug",
        description: "Something broke",
      }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("issue-create");
      expect(result.data.data.key).toBe("PROJ-42");
      expect(result.data.data.id).toBe("10042");
      expect(result.data.data.self).toBe("https://acme.atlassian.net/rest/api/3/issue/10042");
    }

    // Verify createIssue was called with correct fields
    expect(mockCreateIssue).toHaveBeenCalledOnce();
    const callArg = mockCreateIssue.mock.calls.at(0)?.at(0) as Record<string, unknown>;
    const fields = callArg.fields as Record<string, unknown>;
    expect(fields.project).toEqual({ key: "PROJ" });
    expect(fields.summary).toBe("New bug");
    // Default issue type is "Bug"
    expect(fields.issuetype).toEqual({ name: "Bug" });
  });

  test("creates an issue with labels and priority", async () => {
    mockCreateIssue.mockResolvedValueOnce({
      id: "10043",
      key: "PROJ-43",
      self: "https://acme.atlassian.net/rest/api/3/issue/10043",
    });

    const result = await jiraAgent.execute(
      jsonPrompt({
        operation: "issue-create",
        project_key: "PROJ",
        summary: "Task with priority",
        description: "Details here",
        issue_type: "Task",
        labels: ["backend", "urgent"],
        priority: "Critical",
      }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(true);

    const callArg = mockCreateIssue.mock.calls.at(0)?.at(0) as Record<string, unknown>;
    const fields = callArg.fields as Record<string, unknown>;
    expect(fields.issuetype).toEqual({ name: "Task" });
    expect(fields.labels).toEqual(["backend", "urgent"]);
    expect(fields.priority).toEqual({ name: "Critical" });
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-update
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-update", () => {
  test("updates an issue and returns success", async () => {
    mockEditIssue.mockResolvedValueOnce(undefined);

    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-update", issue_key: "PROJ-10", summary: "Updated summary" }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("issue-update");
      expect(result.data.data.updated).toBe(true);
      expect(result.data.data.issue_key).toBe("PROJ-10");
    }

    // Verify editIssue was called with correct params
    expect(mockEditIssue).toHaveBeenCalledOnce();
    const callArg = mockEditIssue.mock.calls.at(0)?.at(0) as Record<string, unknown>;
    expect(callArg.issueIdOrKey).toBe("PROJ-10");
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-transition
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-transition", () => {
  test("transitions an issue and returns from/to statuses", async () => {
    // 1st call: getTransitions
    mockGetTransitions.mockResolvedValueOnce({
      transitions: [
        { id: "21", name: "In Progress", to: { name: "In Progress" } },
        { id: "31", name: "Done", to: { name: "Done" } },
      ],
    });
    // 2nd call: getIssue for current status
    mockGetIssue.mockResolvedValueOnce({
      key: "PROJ-5",
      id: "10005",
      fields: { status: { name: "Open" } },
    });
    // 3rd call: doTransition
    mockDoTransition.mockResolvedValueOnce(undefined);

    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-transition", issue_key: "PROJ-5", transition_name: "Done" }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("issue-transition");
      expect(result.data.data.from_status).toBe("Open");
      expect(result.data.data.to_status).toBe("Done");
    }
  });

  test("returns error when transition not found", async () => {
    mockGetTransitions.mockResolvedValueOnce({
      transitions: [{ id: "21", name: "In Progress", to: { name: "In Progress" } }],
    });

    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-transition", issue_key: "PROJ-5", transition_name: "Closed" }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain('Transition "Closed" not found');
      expect(result.error.reason).toContain("In Progress");
    }
  });

  test("matches transition name case-insensitively", async () => {
    mockGetTransitions.mockResolvedValueOnce({
      transitions: [{ id: "31", name: "Done", to: { name: "Done" } }],
    });
    mockGetIssue.mockResolvedValueOnce({
      key: "PROJ-5",
      id: "10005",
      fields: { status: { name: "Open" } },
    });
    mockDoTransition.mockResolvedValueOnce(undefined);

    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-transition", issue_key: "PROJ-5", transition_name: "done" }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-comment
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-comment", () => {
  test("adds a comment and returns comment_id", async () => {
    mockAddComment.mockResolvedValueOnce({
      id: "10500",
      self: "https://acme.atlassian.net/rest/api/3/issue/PROJ-5/comment/10500",
    });

    const result = await jiraAgent.execute(
      jsonPrompt({ operation: "issue-comment", issue_key: "PROJ-5", body: "This is a comment" }),
      makeContext(JIRA_ENV),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operation).toBe("issue-comment");
      expect(result.data.data.comment_id).toBe("10500");
      expect(result.data.data.issue_key).toBe("PROJ-5");
    }

    // Verify addComment was called with correct params including ADF body
    expect(mockAddComment).toHaveBeenCalledOnce();
    const callArg = mockAddComment.mock.calls.at(0)?.at(0) as Record<string, unknown>;
    expect(callArg.issueIdOrKey).toBe("PROJ-5");
    const adfBody = callArg.comment as Record<string, unknown>;
    expect(adfBody.type).toBe("doc");
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-search error path
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-search error path", () => {
  test("returns error on API failure", () => {
    mockSearchForIssuesUsingJqlEnhancedSearch.mockRejectedValueOnce(
      new Error("Request failed with status code 400"),
    );

    return jiraAgent
      .execute(
        jsonPrompt({ operation: "issue-search", jql: "invalid jql!!!" }),
        makeContext(JIRA_ENV),
      )
      .then((result) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.reason).toContain("jira issue-search failed");
          expect(result.error.reason).toContain("400");
        }
      });
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-create error path
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-create error path", () => {
  test("returns error on API failure", () => {
    mockCreateIssue.mockRejectedValueOnce(
      new Error("Request failed with status code 400: project not found"),
    );

    return jiraAgent
      .execute(
        jsonPrompt({ operation: "issue-create", project_key: "NOPE", summary: "Will fail" }),
        makeContext(JIRA_ENV),
      )
      .then((result) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.reason).toContain("jira issue-create failed");
        }
      });
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-update error path
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-update error path", () => {
  test("returns error on API failure", () => {
    mockEditIssue.mockRejectedValueOnce(new Error("Request failed with status code 404"));

    return jiraAgent
      .execute(
        jsonPrompt({ operation: "issue-update", issue_key: "PROJ-999", summary: "Updated" }),
        makeContext(JIRA_ENV),
      )
      .then((result) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.reason).toContain("jira issue-update failed");
        }
      });
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-comment error path
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-comment error path", () => {
  test("returns error on API failure", () => {
    mockAddComment.mockRejectedValueOnce(new Error("Request failed with status code 403"));

    return jiraAgent
      .execute(
        jsonPrompt({ operation: "issue-comment", issue_key: "PROJ-5", body: "Comment text" }),
        makeContext(JIRA_ENV),
      )
      .then((result) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.reason).toContain("jira issue-comment failed");
        }
      });
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-search edge cases
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-search edge cases", () => {
  test("handles empty search results", () => {
    mockSearchForIssuesUsingJqlEnhancedSearch.mockResolvedValueOnce({
      issues: [],
      total: 0,
      maxResults: 50,
      startAt: 0,
    });

    return jiraAgent
      .execute(
        jsonPrompt({ operation: "issue-search", jql: "project = EMPTY" }),
        makeContext(JIRA_ENV),
      )
      .then((result) => {
        expect(result.ok).toBe(true);
        if (result.ok) {
          const issues = result.data.data.issues as unknown[];
          expect(issues).toEqual([]);
        }
      });
  });

  test("handles undefined issues field", () => {
    mockSearchForIssuesUsingJqlEnhancedSearch.mockResolvedValueOnce({
      total: 0,
      maxResults: 50,
      startAt: 0,
    });

    return jiraAgent
      .execute(
        jsonPrompt({ operation: "issue-search", jql: "project = EMPTY" }),
        makeContext(JIRA_ENV),
      )
      .then((result) => {
        expect(result.ok).toBe(true);
        if (result.ok) {
          const issues = result.data.data.issues as unknown[];
          expect(issues).toEqual([]);
        }
      });
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-view edge cases
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-view edge cases", () => {
  test("handles null fields in issue response", () => {
    mockGetIssue.mockResolvedValueOnce({
      key: "X-1",
      id: "1",
      fields: {
        summary: "Minimal",
        status: null,
        priority: null,
        assignee: null,
        reporter: null,
        description: null,
        labels: [],
        issuetype: null,
        created: "2026-01-01",
        updated: "2026-01-01",
      },
    });

    return jiraAgent
      .execute(jsonPrompt({ operation: "issue-view", issue_key: "X-1" }), makeContext(JIRA_ENV))
      .then((result) => {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.data.summary).toBe("Minimal");
          expect(result.data.data.status).toBeUndefined();
          expect(result.data.data.priority).toBeUndefined();
          expect(result.data.data.assignee).toBeUndefined();
          expect(result.data.data.reporter).toBeUndefined();
          expect(result.data.data.description).toBe("");
          expect(result.data.data.labels).toEqual([]);
        }
      });
  });
});

// ---------------------------------------------------------------------------
// textToAdfContent — URL with parentheses
// ---------------------------------------------------------------------------
describe("textToAdfContent — URLs with parentheses", () => {
  test("handles URL with balanced parentheses (Wikipedia style)", () => {
    const result = textToAdfContent("[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))");
    expect(result).toEqual([
      {
        type: "text",
        text: "Wiki",
        marks: [{ type: "link", attrs: { href: "https://en.wikipedia.org/wiki/Foo_(bar)" } }],
      },
    ]);
  });

  test("normal URLs still work after regex update", () => {
    const result = textToAdfContent("[Click](https://example.com)");
    expect(result).toEqual([
      {
        type: "text",
        text: "Click",
        marks: [{ type: "link", attrs: { href: "https://example.com" } }],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// jiraAgent handler — issue-create without description
// ---------------------------------------------------------------------------
describe("jiraAgent handler — issue-create without description", () => {
  test("creates an issue without description field", () => {
    mockCreateIssue.mockResolvedValueOnce({
      id: "10044",
      key: "PROJ-44",
      self: "https://acme.atlassian.net/rest/api/3/issue/10044",
    });

    return jiraAgent
      .execute(
        jsonPrompt({
          operation: "issue-create",
          project_key: "PROJ",
          summary: "No description issue",
        }),
        makeContext(JIRA_ENV),
      )
      .then((result) => {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.data.key).toBe("PROJ-44");
        }

        // Verify description is undefined in the API call
        const callArg = mockCreateIssue.mock.calls.at(0)?.at(0) as Record<string, unknown>;
        const fields = callArg.fields as Record<string, unknown>;
        expect(fields.description).toBeUndefined();
      });
  });
});

// ---------------------------------------------------------------------------
// jiraAgent metadata
// ---------------------------------------------------------------------------
describe("jiraAgent metadata", () => {
  test("has correct id", () => {
    expect(jiraAgent.metadata.id).toBe("jira");
  });

  test("has correct displayName", () => {
    expect(jiraAgent.metadata.displayName).toBe("Jira Cloud");
  });

  test("has linkRef for email and api_token env vars", () => {
    const required = jiraAgent.environmentConfig?.required ?? [];
    const emailEnv = required.find((r) => r.name === "JIRA_EMAIL");
    const tokenEnv = required.find((r) => r.name === "JIRA_API_TOKEN");
    expect(emailEnv?.linkRef).toEqual({ provider: "jira", key: "email" });
    expect(tokenEnv?.linkRef).toEqual({ provider: "jira", key: "api_token" });
  });

  test("JIRA_SITE env var has no linkRef", () => {
    const required = jiraAgent.environmentConfig?.required ?? [];
    const siteEnv = required.find((r) => r.name === "JIRA_SITE");
    expect(siteEnv).toBeDefined();
    expect(siteEnv?.linkRef).toBeUndefined();
  });
});
