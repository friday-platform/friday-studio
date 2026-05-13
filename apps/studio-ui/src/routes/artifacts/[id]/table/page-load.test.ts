/**
 * @vitest-environment happy-dom
 *
 * Loader unit tests. The SvelteKit `+page.ts` export is invoked
 * directly with a hand-rolled `params`/`fetch` so we exercise the
 * fallback ladders (workspace name from config vs daemon name,
 * filename from originalName vs artifact.title) and the error paths
 * (missing artifact, 404, bad daemon shape) without spinning up a
 * real router.
 */
import { describe, expect, it, vi } from "vitest";
import { load } from "./+page.ts";

type FetchImpl = (url: string | URL) => Promise<Response>;

/** Builds a typed mock `fetch` from a route-pattern → response map. */
function mockFetch(routes: Record<string, { ok: boolean; status?: number; body?: unknown }>): FetchImpl {
  // Match longest pattern first so `/workspaces/ws/chat/chat_1` wins
  // over `/workspaces/ws` when both are registered. Without this the
  // shorter prefix swallows the more-specific route.
  const patterns = Object.keys(routes).sort((a, b) => b.length - a.length);
  return vi.fn(async (url) => {
    const u = typeof url === "string" ? url : url.toString();
    const matched = patterns.find((pattern) => u.includes(pattern));
    if (!matched) {
      throw new Error(`unhandled fetch in test: ${u}`);
    }
    const r = routes[matched]!;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      headers: new Headers(),
      json: async () => r.body ?? {},
      text: async () => "",
    } as unknown as Response;
  }) as FetchImpl;
}

// SvelteKit's `load` signature has a lot of fields the loader doesn't
// touch — supply `params` + `fetch` and cast for the call. Keeps the
// test focused on the loader's actual behavior.
// The runtime return of `load` is always an object (the table route
// never calls `throw redirect`), but SvelteKit's `PageLoad` type widens
// to `void | PageData` because the type signature also covers redirect-
// only loaders. Narrow back to the concrete object so test assertions
// can read properties without `void` polluting the union.
type LoadResult = Exclude<Awaited<ReturnType<typeof load>>, void>;

function invokeLoad(artifactId: string, fetch: FetchImpl): Promise<LoadResult> {
  // biome-ignore lint/suspicious/noExplicitAny: SvelteKit load event has many unused fields
  return (load as any)({ params: { id: artifactId }, fetch }) as Promise<LoadResult>;
}

describe("/artifacts/[id]/table loader", () => {
  it("returns the artifact text + mimeType + filename on the happy path", async () => {
    const fetch = mockFetch({
      "/artifacts/art_1": {
        ok: true,
        body: {
          artifact: {
            title: "ignored",
            data: { mimeType: "text/csv", originalName: "employees.csv" },
            workspaceId: "ws",
            chatId: "chat_1",
          },
          contents: "id,name\n1,Alice",
        },
      },
      "/workspaces/ws": {
        ok: true,
        body: { name: "Personal", config: { workspace: { name: "My Personal Workspace" } } },
      },
      "/workspaces/ws/chat/chat_1": {
        ok: true,
        body: { chat: { title: "Q3 numbers" } },
      },
    });

    const result = await invokeLoad("art_1", fetch);
    expect(result.artifactId).toBe("art_1");
    expect(result.mimeType).toBe("text/csv");
    expect(result.filename).toBe("employees.csv");
    expect(result.text).toBe("id,name\n1,Alice");
    expect(result.workspaceId).toBe("ws");
    expect(result.workspaceName).toBe("My Personal Workspace");
    expect(result.chatId).toBe("chat_1");
    expect(result.chatTitle).toBe("Q3 numbers");
  });

  it("falls back to the artifact title when originalName is missing", async () => {
    const fetch = mockFetch({
      "/artifacts/art_x": {
        ok: true,
        body: {
          artifact: {
            title: "My Table",
            data: { mimeType: "text/markdown" },
            workspaceId: "ws",
          },
          contents: "| a |",
        },
      },
      "/workspaces/ws": { ok: true, body: { name: "Personal" } },
    });
    const result = await invokeLoad("art_x", fetch);
    expect(result.filename).toBe("My Table");
  });

  it("falls back to top-level workspace name when config.workspace.name is missing", async () => {
    const fetch = mockFetch({
      "/artifacts/art_x": {
        ok: true,
        body: {
          artifact: {
            title: "t",
            data: { mimeType: "text/csv", originalName: "t.csv" },
            workspaceId: "ws",
          },
          contents: "",
        },
      },
      "/workspaces/ws": { ok: true, body: { name: "Daemon Name" } },
    });
    const result = await invokeLoad("art_x", fetch);
    expect(result.workspaceName).toBe("Daemon Name");
  });

  it("returns null workspaceName when the workspace lookup fails", async () => {
    const fetch = mockFetch({
      "/artifacts/art_x": {
        ok: true,
        body: {
          artifact: {
            title: "t",
            data: { mimeType: "text/csv", originalName: "t.csv" },
            workspaceId: "deleted",
          },
          contents: "",
        },
      },
      "/workspaces/deleted": { ok: false, status: 404 },
    });
    const result = await invokeLoad("art_x", fetch);
    expect(result.workspaceName).toBeNull();
  });

  it("returns null chatTitle when the chat lookup fails", async () => {
    const fetch = mockFetch({
      "/artifacts/art_x": {
        ok: true,
        body: {
          artifact: {
            title: "t",
            data: { mimeType: "text/csv", originalName: "t.csv" },
            workspaceId: "ws",
            chatId: "chat_deleted",
          },
          contents: "",
        },
      },
      "/workspaces/ws": { ok: true, body: { name: "Personal" } },
      "/workspaces/ws/chat/chat_deleted": { ok: false, status: 404 },
    });
    const result = await invokeLoad("art_x", fetch);
    expect(result.chatTitle).toBeNull();
  });

  it("omits chat lookup when artifact has no chatId", async () => {
    let chatLookupCalled = false;
    const fetch = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/chat/")) chatLookupCalled = true;
      if (u.includes("/artifacts/art_x")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            artifact: {
              title: "t",
              data: { mimeType: "text/csv", originalName: "t.csv" },
              workspaceId: "ws",
              // no chatId
            },
            contents: "",
          }),
        } as Response;
      }
      if (u.includes("/workspaces/ws")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ name: "Personal" }),
        } as Response;
      }
      throw new Error(`unhandled: ${u}`);
    });
    const result = await invokeLoad("art_x", fetch as unknown as FetchImpl);
    expect(chatLookupCalled).toBe(false);
    expect(result.chatId).toBeNull();
    expect(result.chatTitle).toBeNull();
  });

  it("throws a 404 when the artifact doesn't exist", async () => {
    const fetch = mockFetch({
      "/artifacts/art_missing": { ok: false, status: 404 },
    });
    await expect(invokeLoad("art_missing", fetch)).rejects.toMatchObject({ status: 404 });
  });

  it("throws when the daemon returns a malformed response", async () => {
    const fetch = mockFetch({
      "/artifacts/art_bad": { ok: true, body: { contents: "no artifact field" } },
    });
    await expect(invokeLoad("art_bad", fetch)).rejects.toMatchObject({ status: 500 });
  });

  it("defaults mimeType to application/octet-stream when artifact data lacks it", async () => {
    const fetch = mockFetch({
      "/artifacts/art_x": {
        ok: true,
        body: {
          artifact: {
            title: "t",
            data: { originalName: "t.bin" },
            workspaceId: "ws",
          },
          contents: "",
        },
      },
      "/workspaces/ws": { ok: true, body: { name: "Personal" } },
    });
    const result = await invokeLoad("art_x", fetch);
    expect(result.mimeType).toBe("application/octet-stream");
  });
});
