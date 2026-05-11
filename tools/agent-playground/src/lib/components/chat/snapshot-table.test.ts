/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotTableToArtifact } from "./snapshot-table.ts";

// Mock `fetch` at the module boundary — we don't bring up a real
// daemon for these tests. The helper makes one optional chat-title
// fetch + one artifact-create POST, so we drive each scenario by
// queueing per-request fetch responses.

interface MockResponse {
  ok: boolean;
  status?: number;
  body?: unknown;
}

function makeMockFetch(responses: Map<string, MockResponse>) {
  return vi.fn(async (url: string | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    const match = [...responses.keys()].find((pattern) => u.includes(pattern));
    if (!match) {
      throw new Error(`unhandled fetch in test: ${u}`);
    }
    const r = responses.get(match)!;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? ""),
    } as Response;
  });
}

function makeTable(html: string): HTMLTableElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  const table = div.querySelector("table");
  if (!table) throw new Error("test fixture missing <table>");
  return table as HTMLTableElement;
}

const SIMPLE_TABLE = `
  <table>
    <thead><tr><th>id</th><th>name</th></tr></thead>
    <tbody>
      <tr><td>1</td><td>Alice</td></tr>
      <tr><td>2</td><td>Bob</td></tr>
    </tbody>
  </table>
`;

describe("snapshotTableToArtifact", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts the markdown to /api/artifacts and returns the new id", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({
        url: typeof url === "string" ? url : url.toString(),
        body: (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, unknown>,
      });
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/chat/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ chat: { title: "Q3 numbers" } }),
        } as Response;
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ artifact: { id: "art_new" } }),
      } as Response;
    }) as unknown as typeof fetch;

    const id = await snapshotTableToArtifact(makeTable(SIMPLE_TABLE), {
      workspaceId: "ws",
      chatId: "chat_42",
    });
    expect(id).toBe("art_new");

    const createCall = calls.find((c) => c.url.endsWith("/artifacts"));
    expect(createCall).toBeDefined();
    expect(createCall?.body).toMatchObject({
      data: {
        type: "file",
        mimeType: "text/markdown",
      },
      workspaceId: "ws",
      chatId: "chat_42",
      lifecycle: { kind: "durable" },
    });
    // Markdown content should be a real table, not the source HTML.
    expect(createCall?.body.data).toMatchObject({ content: expect.stringContaining("| id | name |") });
  });

  it("uses the chat title as the artifact title when fetch succeeds", async () => {
    let createdTitle = "";
    global.fetch = vi.fn(async (url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/chat/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ chat: { title: "Wide Table" } }),
        } as Response;
      }
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, any>;
      createdTitle = body.title;
      return {
        ok: true,
        status: 201,
        json: async () => ({ artifact: { id: "art_x" } }),
      } as Response;
    }) as unknown as typeof fetch;

    await snapshotTableToArtifact(makeTable(SIMPLE_TABLE), {
      workspaceId: "ws",
      chatId: "chat_42",
    });
    expect(createdTitle).toBe("Table from Wide Table");
  });

  it("falls back to a timestamped title when chat-title lookup fails", async () => {
    let createdTitle = "";
    global.fetch = vi.fn(async (url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/chat/")) {
        // Simulate 404 or daemon unreachable — the helper should
        // degrade to timestamp without surfacing the error.
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, any>;
      createdTitle = body.title;
      return {
        ok: true,
        status: 201,
        json: async () => ({ artifact: { id: "art_x" } }),
      } as Response;
    }) as unknown as typeof fetch;

    await snapshotTableToArtifact(makeTable(SIMPLE_TABLE), {
      workspaceId: "ws",
      chatId: "chat_404",
    });
    // Title starts with "Table — " and contains an ISO-like date.
    expect(createdTitle).toMatch(/^Table — \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("falls back to a timestamped title when no chatId is provided", async () => {
    let createdTitle = "";
    global.fetch = vi.fn(async (_url, init) => {
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, any>;
      createdTitle = body.title;
      return {
        ok: true,
        status: 201,
        json: async () => ({ artifact: { id: "art_x" } }),
      } as Response;
    }) as unknown as typeof fetch;

    await snapshotTableToArtifact(makeTable(SIMPLE_TABLE), { workspaceId: "ws" });
    expect(createdTitle).toMatch(/^Table — \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("honours an explicit title override over the chat-title lookup", async () => {
    let createdTitle = "";
    global.fetch = vi.fn(async (url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/chat/")) {
        // Should NOT be called — the explicit title short-circuits.
        throw new Error("chat-title fetch should not run when title override is set");
      }
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, any>;
      createdTitle = body.title;
      return {
        ok: true,
        status: 201,
        json: async () => ({ artifact: { id: "art_x" } }),
      } as Response;
    }) as unknown as typeof fetch;

    await snapshotTableToArtifact(makeTable(SIMPLE_TABLE), {
      workspaceId: "ws",
      chatId: "chat_42",
      title: "Custom Title",
    });
    expect(createdTitle).toBe("Custom Title");
  });

  it("includes a row × column summary on the artifact", async () => {
    let createdSummary = "";
    global.fetch = vi.fn(async (url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/chat/")) {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, any>;
      createdSummary = body.summary;
      return {
        ok: true,
        status: 201,
        json: async () => ({ artifact: { id: "art_x" } }),
      } as Response;
    }) as unknown as typeof fetch;

    await snapshotTableToArtifact(makeTable(SIMPLE_TABLE), { workspaceId: "ws" });
    expect(createdSummary).toContain("2 columns");
    expect(createdSummary).toContain("2 rows");
  });

  it("throws when the empty table can't be serialized", async () => {
    global.fetch = makeMockFetch(new Map()) as unknown as typeof fetch;
    const empty = makeTable("<table></table>");
    await expect(snapshotTableToArtifact(empty, { workspaceId: "ws" })).rejects.toThrow(
      /empty table/i,
    );
  });

  it("throws when the artifact-create endpoint returns non-OK", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal server error",
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      snapshotTableToArtifact(makeTable(SIMPLE_TABLE), { workspaceId: "ws" }),
    ).rejects.toThrow(/snapshot failed: HTTP 500/);
  });

  it("throws when the create response is missing artifact.id", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ artifact: {} }),
    })) as unknown as typeof fetch;
    await expect(
      snapshotTableToArtifact(makeTable(SIMPLE_TABLE), { workspaceId: "ws" }),
    ).rejects.toThrow(/missing artifact id/);
  });

  it("slugifies the title into a .md originalName", async () => {
    let createdName = "";
    global.fetch = vi.fn(async (url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/chat/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ chat: { title: "Q3 — Numbers & Stats!" } }),
        } as Response;
      }
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, any>;
      createdName = body.data.originalName;
      return {
        ok: true,
        status: 201,
        json: async () => ({ artifact: { id: "art_x" } }),
      } as Response;
    }) as unknown as typeof fetch;

    await snapshotTableToArtifact(makeTable(SIMPLE_TABLE), {
      workspaceId: "ws",
      chatId: "chat_42",
    });
    // Punctuation collapses, all-non-alnum reduces to "-" runs which
    // are then trimmed at the ends. Ends in `.md`.
    expect(createdName).toMatch(/^table-from-q3-numbers-stats\.md$/);
  });

  it("falls back to a 'table.md' originalName when the title is all non-alnum", async () => {
    let createdName = "";
    global.fetch = vi.fn(async (_url, init) => {
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, any>;
      createdName = body.data.originalName;
      return {
        ok: true,
        status: 201,
        json: async () => ({ artifact: { id: "art_x" } }),
      } as Response;
    }) as unknown as typeof fetch;

    await snapshotTableToArtifact(makeTable(SIMPLE_TABLE), {
      workspaceId: "ws",
      title: "!!!",
    });
    expect(createdName).toBe("table.md");
  });
});
