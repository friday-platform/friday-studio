import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { getProvider, listProviders } from "./providers.ts";

// ---------------------------------------------------------------------------
// Helper — build a minimal Hono-like Context for testing
// ---------------------------------------------------------------------------

function makeContext(opts: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  bodyText?: string;
}) {
  const headers = opts.headers ?? {};
  const bodyJson = opts.body ?? {};
  const bodyText = opts.bodyText ?? JSON.stringify(bodyJson);
  let textConsumed = false;

  return {
    req: {
      header(name: string) {
        return headers[name.toLowerCase()];
      },
      text() {
        textConsumed = true;
        return Promise.resolve(bodyText);
      },
      json() {
        if (textConsumed) return Promise.resolve(JSON.parse(bodyText));
        return Promise.resolve(bodyJson);
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("listProviders", () => {
  test("returns providers from config + raw", () => {
    const providers = listProviders();
    expect(providers).toContain("github");
    expect(providers).toContain("bitbucket");
    expect(providers).toContain("raw");
  });
});

describe("getProvider", () => {
  test("returns handler for known provider", () => {
    expect(getProvider("github")).toBeDefined();
    expect(getProvider("bitbucket")).toBeDefined();
    expect(getProvider("raw")).toBeDefined();
  });

  test("returns undefined for unknown provider", () => {
    expect(getProvider("gitlab")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GitHub provider (config-driven)
// ---------------------------------------------------------------------------

describe("github provider", () => {
  const gh = getProvider("github")!;

  describe("verify", () => {
    test("passes when no secret configured", async () => {
      const c = makeContext({ body: {} });
      expect(await gh.verify(c, undefined)).toBeNull();
    });

    test("fails when signature header is missing", async () => {
      const c = makeContext({ body: {} });
      expect(await gh.verify(c, "secret123")).toBe("Missing x-hub-signature-256 header");
    });

    test("passes with valid HMAC signature", async () => {
      const body = '{"action":"opened"}';
      const hmac = createHmac("sha256", "mysecret").update(body).digest("hex");
      const c = makeContext({
        headers: { "x-hub-signature-256": `sha256=${hmac}` },
        bodyText: body,
      });
      expect(await gh.verify(c, "mysecret")).toBeNull();
    });
  });

  describe("transform", () => {
    test("returns null for events not in config", async () => {
      const c = makeContext({ headers: { "x-github-event": "deployment" }, body: {} });
      expect(await gh.transform(c)).toBeNull();
    });

    test("returns null for filtered actions", async () => {
      const c = makeContext({
        headers: { "x-github-event": "pull_request" },
        body: { action: "closed", pull_request: { html_url: "https://github.com/o/r/pull/1" } },
      });
      expect(await gh.transform(c)).toBeNull();
    });

    test("extracts pr_url for opened action", async () => {
      const c = makeContext({
        headers: { "x-github-event": "pull_request" },
        body: { action: "opened", pull_request: { html_url: "https://github.com/o/r/pull/42" } },
      });
      const result = await gh.transform(c);
      expect(result?.payload).toEqual({ pr_url: "https://github.com/o/r/pull/42" });
    });

    test("extracts pr_url for synchronize action", async () => {
      const c = makeContext({
        headers: { "x-github-event": "pull_request" },
        body: {
          action: "synchronize",
          pull_request: { html_url: "https://github.com/o/r/pull/3" },
        },
      });
      const result = await gh.transform(c);
      expect(result?.payload).toEqual({ pr_url: "https://github.com/o/r/pull/3" });
    });

    test("extracts push event fields", async () => {
      const c = makeContext({
        headers: { "x-github-event": "push" },
        body: {
          ref: "refs/heads/main",
          after: "abc123",
          repository: { full_name: "owner/repo" },
          pusher: { name: "user1" },
        },
      });
      const result = await gh.transform(c);
      expect(result?.payload).toEqual({
        ref: "refs/heads/main",
        sha: "abc123",
        repo: "owner/repo",
        pusher: "user1",
      });
    });

    test("extracts issue event fields", async () => {
      const c = makeContext({
        headers: { "x-github-event": "issues" },
        body: {
          action: "opened",
          issue: { html_url: "https://github.com/o/r/issues/5", number: 5, title: "Bug report" },
        },
      });
      const result = await gh.transform(c);
      expect(result?.payload).toEqual({
        issue_url: "https://github.com/o/r/issues/5",
        issue_key: 5,
        title: "Bug report",
        action: "opened",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Bitbucket provider (config-driven)
// ---------------------------------------------------------------------------

describe("bitbucket provider", () => {
  const bb = getProvider("bitbucket")!;

  describe("verify", () => {
    test("passes when no secret configured", async () => {
      const c = makeContext({ body: {} });
      expect(await bb.verify(c, undefined)).toBeNull();
    });

    test("fails when signature header is missing", async () => {
      const c = makeContext({ body: {} });
      expect(await bb.verify(c, "secret")).toBe("Missing x-hub-signature header");
    });
  });

  describe("transform", () => {
    test("returns null for events not in config", async () => {
      const c = makeContext({ headers: { "x-event-key": "repo:fork" }, body: {} });
      expect(await bb.transform(c)).toBeNull();
    });

    test("extracts pr_url for pullrequest:created", async () => {
      const c = makeContext({
        headers: { "x-event-key": "pullrequest:created" },
        body: {
          pullrequest: {
            links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/5" } },
          },
        },
      });
      const result = await bb.transform(c);
      expect(result?.payload).toEqual({ pr_url: "https://bitbucket.org/ws/repo/pull-requests/5" });
    });

    test("extracts push event fields with array index", async () => {
      const c = makeContext({
        headers: { "x-event-key": "repo:push" },
        body: {
          repository: { full_name: "ws/repo" },
          push: { changes: [{ new: { name: "main", target: { hash: "def456" } } }] },
        },
      });
      const result = await bb.transform(c);
      expect(result?.payload).toEqual({ repo: "ws/repo", branch: "main", sha: "def456" });
    });
  });
});

// ---------------------------------------------------------------------------
// Jira provider (body-based event identification)
// ---------------------------------------------------------------------------

describe("jira provider", () => {
  const jira = getProvider("jira")!;

  test("extracts issue fields from jira:issue_created", async () => {
    const c = makeContext({
      body: {
        webhookEvent: "jira:issue_created",
        issue: { key: "DEV-42", fields: { project: { key: "DEV" }, summary: "Missing badge" } },
      },
    });
    const result = await jira.transform(c);
    expect(result?.payload.issue_key).toBe("DEV-42");
    expect(result?.payload.project_key).toBe("DEV");
    expect(result?.payload.summary).toBe("Missing badge");
  });

  test("returns null for unconfigured events", async () => {
    const c = makeContext({ body: { webhookEvent: "jira:issue_deleted" } });
    expect(await jira.transform(c)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Raw provider
// ---------------------------------------------------------------------------

describe("raw provider", () => {
  const raw = getProvider("raw")!;

  test("verify always passes", async () => {
    const c = makeContext({ body: {} });
    expect(await raw.verify(c, "anysecret")).toBeNull();
  });

  test("passes body through as-is", async () => {
    const body = { issue_key: "DEV-5", repo_url: "https://bitbucket.org/ws/repo" };
    const c = makeContext({ body });
    const result = await raw.transform(c);
    expect(result?.payload).toEqual(body);
  });
});
