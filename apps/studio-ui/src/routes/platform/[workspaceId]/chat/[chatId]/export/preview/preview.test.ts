/**
 * Tracer-bullet tests for the export-preview page.
 *
 * Two-pronged because the SvelteKit integration harness isn't set up
 * elsewhere in this repo:
 *
 *   A. `load` from `+page.server.ts` — unit-tested with a stubbed
 *      `event.fetch` returning canned daemon JSON.
 *   B. `+page.svelte` — rendered via `svelte/server`'s `render()` (same
 *      harness as `artifact-card.test.ts`), assertions against the body
 *      string.
 *
 * NOTE: the inline-`<style>` AC item is a SvelteKit-pipeline concern
 * (`kit.inlineStyleThreshold: Infinity`, set in T3) that `svelte/server`'s
 * `render()` doesn't exercise — it is verified by manual browser QA and
 * will eventually be covered when T8's orchestrator round-trips through
 * SvelteKit at request time.
 */

import { readable } from "svelte/store";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import type { ArtifactPrefetch } from "$lib/components/chat/export-context";
import { artifactZipPath, slugifyZipBasename } from "$lib/export/artifact-zip-path";

// `@atlas/ui` is a single-entry barrel that pulls in `@tanstack/svelte-table`
// at module load. The alpha dist ships extensionless `.svelte` imports that
// Deno's strict ESM resolver rejects. The render path here only needs icons
// and a markdown renderer; stub the whole barrel with minimal SVG components
// + a passthrough `markdownToHTML` so the import graph stays traversable.
vi.mock("@atlas/ui", async () => {
  const mod = await import(
    "$lib/components/chat/__test-stubs__/icon-stub.svelte"
  );
  const Stub = mod.default;
  const proxy = new Proxy({}, { get: () => Stub });
  return {
    Icons: proxy,
    IconSmall: proxy,
    Button: Stub,
    DropdownMenu: proxy,
    MarkdownRendered: Stub,
    markdownToHTML: (text: string) => text,
    markdownToHTMLSafe: (text: string) => text,
  };
});

// Vitest does not load the SvelteKit Vite plugin, so `$app/stores` never
// gets registered. Components in the import graph (e.g. connect-communicator)
// read `page` at module init; an empty store is enough for SSR.
vi.mock("$app/stores", () => ({
  page: readable({ url: new URL("http://localhost/"), params: {}, data: {} }),
  navigating: readable(null),
  updated: readable(false),
}));
vi.mock("$app/state", () => ({
  page: { url: new URL("http://localhost/"), params: {}, data: {} },
  navigating: null,
  updated: { current: false },
}));
vi.mock("$app/navigation", () => ({
  goto: () => Promise.resolve(),
  invalidate: () => Promise.resolve(),
  invalidateAll: () => Promise.resolve(),
}));

// connect-service / connect-communicator / human-input-tool-card are imported
// by tool-call-card but only render under specific tool names; mock them with
// the icon stub so the graph closes without dragging in `$app/*` virtual
// modules they depend on or `@tanstack/svelte-query` which vitest can't parse.
vi.mock("$lib/components/chat/connect-service.svelte", async () => {
  return await import("$lib/components/chat/__test-stubs__/icon-stub.svelte");
});
vi.mock("$lib/components/chat/connect-communicator.svelte", async () => {
  return await import("$lib/components/chat/__test-stubs__/icon-stub.svelte");
});
vi.mock("$lib/components/chat/human-input-tool-card.svelte", async () => {
  return await import("$lib/components/chat/__test-stubs__/icon-stub.svelte");
});

const { load } = await import("./+page.server");
const { default: Page } = await import("./+page@.svelte");

interface DaemonChatPayload {
  chat: {
    id: string;
    userId: string;
    workspaceId: string;
    source: string;
    title?: string;
    createdAt: string;
    updatedAt: string;
  };
  messages: unknown[];
  systemPromptContext: null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const sampleChat: DaemonChatPayload = {
  chat: {
    id: "chat_abc",
    userId: "user-1",
    workspaceId: "user",
    source: "playground",
    title: "Tracer Bullet Chat",
    createdAt: "2026-05-04T12:00:00.000Z",
    updatedAt: "2026-05-04T12:05:00.000Z",
  },
  messages: [
    {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "hello from the user" }],
      metadata: { timestamp: "2026-05-04T12:00:01.000Z" },
    },
    {
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "hello back from the assistant" }],
      metadata: { timestamp: "2026-05-04T12:00:02.000Z" },
    },
  ],
  systemPromptContext: null,
};

const sampleArtifacts = [
  {
    id: "art-1",
    type: "file",
    revision: 1,
    title: "Diagram",
    summary: "A test diagram",
    createdAt: "2026-05-04T12:00:00.000Z",
    workspaceId: "user",
    chatId: "chat_abc",
    mimeType: "image/png",
    size: 1024,
    originalName: "diagram.png",
  },
];

/**
 * Minimal `event` stub for the load function. Only the fields `load`
 * actually reads are populated; SvelteKit decorates `event` with many
 * more, but typing the stub as `Parameters<typeof load>[0]` would force
 * us to fake all of them, so we narrow with a focused interface here.
 */
interface LoadEvent {
  params: { workspaceId?: string; chatId?: string };
  fetch: typeof globalThis.fetch;
}

function makeFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.startsWith(pattern)) return handler();
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;
}

// `load` is a SvelteKit `PageServerLoad` — we narrow our stub to what
// it actually reads. The `as never` is only needed so `load` accepts
// our partial `event`; the test fixture is the documented exception to
// the no-`as` rule (see CLAUDE.md / quality bar).
function callLoad(event: LoadEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return load(event as any);
}

describe("export-preview load()", () => {
  it("returns chat + messages + ArtifactPrefetch[] on the happy path", async () => {
    const event: LoadEvent = {
      params: { workspaceId: "user", chatId: "chat_abc" },
      fetch: makeFetch({
        "/api/daemon/api/workspaces/user/chat/chat_abc": () => jsonResponse(sampleChat),
        "/api/daemon/api/artifacts": () => jsonResponse({ artifacts: sampleArtifacts }),
      }),
    };

    const result = await callLoad(event);
    if (!result) throw new Error("load returned void");

    expect(result.chat.id).toBe("chat_abc");
    expect(result.chat.title).toBe("Tracer Bullet Chat");
    expect(result.messages).toHaveLength(2);
    expect(result.artifacts).toEqual<ArtifactPrefetch[]>([
      {
        id: "art-1",
        title: "Diagram",
        summary: "A test diagram",
        mimeType: "image/png",
        size: 1024,
        originalName: "diagram.png",
      },
    ]);
  });

  it("propagates 404 from the daemon's chat endpoint as a 404 error", async () => {
    const event: LoadEvent = {
      params: { workspaceId: "user", chatId: "missing" },
      fetch: makeFetch({
        "/api/daemon/api/workspaces/user/chat/missing": () =>
          jsonResponse({ error: "Chat not found" }, 404),
        "/api/daemon/api/artifacts": () => jsonResponse({ artifacts: [] }),
      }),
    };

    await expect(callLoad(event)).rejects.toMatchObject({ status: 404 });
  });

  it("renders with empty artifacts when the artifact list endpoint errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event: LoadEvent = {
      params: { workspaceId: "user", chatId: "chat_abc" },
      fetch: makeFetch({
        "/api/daemon/api/workspaces/user/chat/chat_abc": () => jsonResponse(sampleChat),
        "/api/daemon/api/artifacts": () => jsonResponse({ error: "boom" }, 500),
      }),
    };

    const result = await callLoad(event);
    if (!result) throw new Error("load returned void");
    expect(result.artifacts).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("export-preview +page.svelte render", () => {
  function makePageData() {
    const messages: AtlasUIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hello from the user" }],
        metadata: { timestamp: "2026-05-04T12:00:01.000Z" },
      },
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "hello back from the assistant" }],
        metadata: { timestamp: "2026-05-04T12:00:02.000Z" },
      },
    ] as unknown as AtlasUIMessage[]; // test fixture exempt from no-`as` rule
    const artifacts: ArtifactPrefetch[] = [
      {
        id: "art-1",
        title: "Diagram",
        mimeType: "image/png",
        size: 1024,
        originalName: "diagram.png",
      },
    ];
    return {
      chat: sampleChat.chat,
      messages,
      artifacts,
    };
  }

  it("renders message bubbles for both user and assistant turns", () => {
    const { body } = render(Page, { props: { data: makePageData() } });
    expect(body).toContain("hello from the user");
    expect(body).toContain("hello back from the assistant");
    // The chat-message-list root element carries this class.
    expect(body).toContain("message-list");
  });

  it("never references the live daemon proxy path in the rendered HTML", () => {
    const { body } = render(Page, { props: { data: makePageData() } });
    expect(body).not.toContain("/api/daemon/");
  });

  it("includes the chat title in the page header", () => {
    const { body } = render(Page, { props: { data: makePageData() } });
    expect(body).toContain("Tracer Bullet Chat");
  });
});

describe("artifactZipPath helper (resolveUrl contract)", () => {
  it("produces a relative `assets/artifacts/{id}/{slugified-filename}` path", () => {
    expect(
      artifactZipPath({
        id: "art-1",
        mimeType: "image/png",
        originalName: "diagram.png",
        title: "Diagram",
      }),
    ).toBe("assets/artifacts/art-1/diagram.png");
  });

  it("slugifies non-ASCII characters and strips path separators", () => {
    expect(
      artifactZipPath({
        id: "art-2",
        mimeType: "text/plain",
        originalName: "../sneaky path/файл.txt",
        title: "Notes",
      }),
    ).toBe("assets/artifacts/art-2/.._sneaky_path_____.txt");
  });

  it("falls back to the title when originalName is absent", () => {
    expect(
      artifactZipPath({
        id: "art-3",
        mimeType: "text/markdown",
        title: "Project Notes",
      }),
    ).toBe("assets/artifacts/art-3/Project_Notes.md");
  });

  it("slugifies the id so a hostile id cannot escape `assets/artifacts/`", () => {
    // Defense in depth — daemon-generated ids today are UUID-shaped, but
    // a future change or a compromised daemon shouldn't be able to write
    // a zip entry outside the assets dir. JSZip honours whatever path
    // string we hand it.
    const path = artifactZipPath({
      id: "../../etc/passwd",
      mimeType: "text/plain",
      originalName: "x.txt",
      title: "Untitled",
    });
    expect(path).toBe("assets/artifacts/.._.._etc_passwd/x.txt");
    expect(path).not.toMatch(/(^|\/)\.\.(\/|$)/);
  });

  // `.` and `-` are in the slug whitelist, so a pure-dot input (`..`, `.`,
  // `...`) sails through unchanged unless we reject it explicitly. Without
  // the explicit reject the helper produces `assets/artifacts/../<base>`
  // — a path-traversal escape the previous fix missed.
  it.each([
    ["double-dot", ".."],
    ["single-dot", "."],
    ["triple-dot", "..."],
  ])("rejects pure-dot id (%s) and falls back to the artifact default", (_label, id) => {
    const path = artifactZipPath({
      id,
      mimeType: "text/plain",
      originalName: "x.txt",
      title: "Untitled",
    });
    expect(path).toBe("assets/artifacts/artifact/x.txt");
    expect(path).not.toMatch(/(^|\/)\.+(\/|$)/);
  });
});

// Direct unit tests of the slug helper — `artifactZipPath` calls
// `slugifyZipBasename` twice (once for `id`, once for the derived
// basename), and `deriveDownloadFilename` always appends a mime
// extension so the basename branch can't currently receive a pure-dot
// input. But the helper is the load-bearing rule, and any future
// caller (or a refactor of `deriveDownloadFilename`) inherits it. Pin
// the rule directly so a regression that gates the pure-dot reject
// behind a call-site check (or accidentally narrows the regex) fails
// here regardless of which caller it touches.
describe("slugifyZipBasename — pure-dot reject and dotfile preservation", () => {
  it.each([
    ["double-dot", ".."],
    ["single-dot", "."],
    ["triple-dot", "..."],
    ["five-dots", "....."],
  ])("rejects pure-dot input (%s) and returns the artifact default", (_label, input) => {
    expect(slugifyZipBasename(input)).toBe("artifact");
  });

  it.each([
    ["leading-dot dotfile", ".gitignore"],
    ["trailing-dot", "name."],
    ["dot-in-middle", "name.ext"],
    ["multi-extension", "archive.tar.gz"],
    ["dot-prefix-with-letters", ".env.local"],
  ])("preserves legitimate filenames containing dots (%s)", (_label, input) => {
    expect(slugifyZipBasename(input)).toBe(input);
  });

  it("returns the artifact default for the empty string", () => {
    expect(slugifyZipBasename("")).toBe("artifact");
  });

  it("rewrites disallowed characters to underscore but preserves allowed dots", () => {
    expect(slugifyZipBasename("a/b\\c.d")).toBe("a_b_c.d");
  });
});
