/**
 * Unit tests for `composeMemoryBlocks` — the shared memory-block composer
 * consumed by both the chat supervisor and FSM `type: llm` actions.
 *
 * Stubs the daemon's `/api/memory/...` HTTP surface via `fetch` and asserts:
 *   - empty stores → empty block list
 *   - narrative entries are wrapped in the agreed `<memory ...>` envelope
 *   - non-narrative kinds (`scratchpad`, `state`) are excluded
 *   - per-(workspace, store) deduplication works across foreground IDs
 *   - a list-call failure for one workspace doesn't poison the others
 */

import { describe, expect, it, vi } from "vitest";
import { composeMemoryBlocks } from "./compose-blocks.ts";

vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:3000" }));

const mkLogger = () => ({
  debug: () => {},
  info: () => {},
  warn: vi.fn(),
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => mkLogger(),
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("composeMemoryBlocks", () => {
  it("returns no blocks when no narrative stores exist", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/memory/ws-1")) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const blocks = await composeMemoryBlocks(
      "ws-1",
      [],
      mkLogger() as unknown as Parameters<typeof composeMemoryBlocks>[2],
    );
    expect(blocks).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("emits XML-wrapped block per narrative store with limit=20 entries", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/memory/ws-1")) {
        return jsonResponse([
          { workspaceId: "ws-1", name: "decisions", kind: "narrative" },
          { workspaceId: "ws-1", name: "scratch", kind: "scratchpad" },
        ]);
      }
      if (url.includes("/api/memory/ws-1/narrative/decisions")) {
        // Verify limit=20 query param is present.
        expect(url).toContain("limit=20");
        return jsonResponse([
          { id: "e1", text: "Decision A", createdAt: "2026-01-01T00:00:00Z" },
          { id: "e2", text: "Decision B", createdAt: "2026-01-02T00:00:00Z" },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const blocks = await composeMemoryBlocks(
      "ws-1",
      [],
      mkLogger() as unknown as Parameters<typeof composeMemoryBlocks>[2],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<memory workspace="ws-1" store="decisions">');
    expect(blocks[0]).toContain("- Decision A");
    expect(blocks[0]).toContain("- Decision B");
    expect(blocks[0]).toContain("</memory>");
    expect(blocks[0]).not.toContain("scratch");
    vi.unstubAllGlobals();
  });

  it("deduplicates the same source store across primary and foreground", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/memory/ws-1") || url.endsWith("/api/memory/ws-2")) {
        return jsonResponse([{ workspaceId: "src-ws", name: "shared", kind: "narrative" }]);
      }
      if (url.includes("/api/memory/src-ws/narrative/shared")) {
        return jsonResponse([
          { id: "e1", text: "Shared entry", createdAt: "2026-01-01T00:00:00Z" },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const blocks = await composeMemoryBlocks(
      "ws-1",
      ["ws-2"],
      mkLogger() as unknown as Parameters<typeof composeMemoryBlocks>[2],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<memory workspace="src-ws" store="shared">');
    vi.unstubAllGlobals();
  });

  it("survives an HTTP error from one workspace's list call", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/memory/ws-broken")) {
        return new Response("oops", { status: 500 });
      }
      if (url.endsWith("/api/memory/ws-ok")) {
        return jsonResponse([{ workspaceId: "ws-ok", name: "notes", kind: "narrative" }]);
      }
      if (url.includes("/api/memory/ws-ok/narrative/notes")) {
        return jsonResponse([
          { id: "e1", text: "Surviving entry", createdAt: "2026-01-01T00:00:00Z" },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const blocks = await composeMemoryBlocks(
      "ws-broken",
      ["ws-ok"],
      mkLogger() as unknown as Parameters<typeof composeMemoryBlocks>[2],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<memory workspace="ws-ok" store="notes">');
    expect(blocks[0]).toContain("- Surviving entry");
    vi.unstubAllGlobals();
  });
});
