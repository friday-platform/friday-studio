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

import { _setSkillStorageForTest, type SkillStorageAdapter } from "@atlas/skills";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStorage } from "../artifacts/storage.ts";
import {
  ARTIFACT_INJECTION_LIMIT,
  composeArtifactBlocks,
  composeMemoryBlocks,
  composeValidationBlock,
} from "./compose-blocks.ts";

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

/**
 * Phase 9 — Retrieval-gated artifact injection. `composeArtifactBlocks`
 * mirrors `composeMemoryBlocks`: pulls recent session-bound artifacts and
 * wraps each one in a `<retrieved_content>` envelope. Tests use the real
 * ArtifactStorage adapter (initialized via vitest.setup.ts) so the
 * lifecycle-filtering predicate gets exercised end-to-end.
 */
describe("composeArtifactBlocks", () => {
  const logger = mkLogger() as unknown as Parameters<typeof composeArtifactBlocks>[1];

  function makeData(text: string): { type: "file"; content: string; mimeType: string } {
    return { type: "file", content: text, mimeType: "text/plain" };
  }

  it("returns empty list when neither sessionId nor chatId is provided", async () => {
    const blocks = await composeArtifactBlocks({ workspaceId: "ws-empty" }, logger);
    expect(blocks).toEqual([]);
  });

  it("returns empty list when no artifacts exist for the session", async () => {
    const sessionId = `sess-empty-${crypto.randomUUID()}`;
    const blocks = await composeArtifactBlocks({ workspaceId: "ws-empty", sessionId }, logger);
    expect(blocks).toEqual([]);
  });

  it("emits one <retrieved_content> envelope per session-bound artifact", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `sess-${crypto.randomUUID()}`;

    // Two ephemeral session-bound artifacts; the composer should surface both.
    const r1 = await ArtifactStorage.create({
      data: makeData("alpha contents"),
      title: "alpha",
      summary: "alpha summary",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
    });
    expect(r1.ok).toBe(true);
    const r2 = await ArtifactStorage.create({
      data: makeData("beta contents"),
      title: "beta",
      summary: "beta summary",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
    });
    expect(r2.ok).toBe(true);

    // A different session's artifact must NOT leak into this session's
    // injection — locality is the entire point of session scoping.
    const otherSession = `sess-other-${crypto.randomUUID()}`;
    await ArtifactStorage.create({
      data: makeData("not for us"),
      title: "leak",
      summary: "should not appear",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId: otherSession } },
    });

    const blocks = await composeArtifactBlocks({ workspaceId, sessionId }, logger);

    expect(blocks).toHaveLength(2);
    // Envelope-format invariants — these are the eval scaffold's contract.
    for (const block of blocks) {
      expect(block).toMatch(/^<retrieved_content provenance="artifact:[^"]+"/);
      expect(block).toContain(`origin="workspace:${workspaceId}/session:${sessionId}"`);
      expect(block).toMatch(/fetched_at="\d{4}-\d{2}-\d{2}T/);
      expect(block).toContain("</retrieved_content>");
    }
    const joined = blocks.join("\n");
    expect(joined).toContain("alpha summary");
    expect(joined).toContain("beta summary");
    expect(joined).not.toContain("should not appear");
  });

  it("surfaces chat-bound artifacts when chatId is provided", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const chatId = `chat-${crypto.randomUUID()}`;

    const r = await ArtifactStorage.create({
      data: makeData("chat-bound contents"),
      title: "chat-1",
      summary: "chat artifact summary",
      workspaceId,
      chatId,
    });
    expect(r.ok).toBe(true);

    const blocks = await composeArtifactBlocks({ workspaceId, chatId }, logger);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("chat artifact summary");
    expect(blocks[0]).toContain(`origin="workspace:${workspaceId}/session:${chatId}"`);
  });

  it("caps emitted blocks at the configured limit (default 10)", async () => {
    const workspaceId = `ws-cap-${crypto.randomUUID()}`;
    const sessionId = `sess-cap-${crypto.randomUUID()}`;

    // Create 12 — exceed the cap by 2 to verify the limit applies.
    for (let i = 0; i < ARTIFACT_INJECTION_LIMIT + 2; i++) {
      const r = await ArtifactStorage.create({
        data: makeData(`item ${i}`),
        title: `t${i}`,
        summary: `summary ${i}`,
        workspaceId,
        lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
      });
      expect(r.ok).toBe(true);
    }

    const blocks = await composeArtifactBlocks({ workspaceId, sessionId }, logger);
    expect(blocks).toHaveLength(ARTIFACT_INJECTION_LIMIT);
  });

  it("respects an explicit limit override", async () => {
    const workspaceId = `ws-lim-${crypto.randomUUID()}`;
    const sessionId = `sess-lim-${crypto.randomUUID()}`;

    for (let i = 0; i < 5; i++) {
      const r = await ArtifactStorage.create({
        data: makeData(`row ${i}`),
        title: `t${i}`,
        summary: `s${i}`,
        workspaceId,
        lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
      });
      expect(r.ok).toBe(true);
    }

    const blocks = await composeArtifactBlocks({ workspaceId, sessionId, limit: 3 }, logger);
    expect(blocks).toHaveLength(3);
  });
});

/**
 * Phase B3 (melodic-strolling-seal-pt2). `composeValidationBlock` looks up the
 * `validating-llm-outputs` system skill (or an author-supplied override) when
 * the resolved validate decision is `"self"` and returns its body for inline
 * appending to the action's system prompt. `skip` and `external` decisions
 * return empty strings — the helper is a no-op for those.
 */
describe("composeValidationBlock", () => {
  function mkAdapter(overrides: Partial<SkillStorageAdapter> = {}): SkillStorageAdapter {
    const stub: SkillStorageAdapter = {
      create: () => Promise.resolve({ ok: true, data: { skillId: "s" } }),
      publish: () =>
        Promise.resolve({ ok: true, data: { id: "i", version: 1, name: "n", skillId: "s" } }),
      get: () => Promise.resolve({ ok: true, data: null }),
      getById: () => Promise.resolve({ ok: true, data: null }),
      getBySkillId: () => Promise.resolve({ ok: true, data: null }),
      list: () => Promise.resolve({ ok: true, data: [] }),
      listVersions: () => Promise.resolve({ ok: true, data: [] }),
      deleteVersion: () => Promise.resolve({ ok: true, data: undefined }),
      setDisabled: () => Promise.resolve({ ok: true, data: undefined }),
      deleteSkill: () => Promise.resolve({ ok: true, data: undefined }),
      listAssigned: () => Promise.resolve({ ok: true, data: [] }),
      assignSkill: () => Promise.resolve({ ok: true, data: undefined }),
      unassignSkill: () => Promise.resolve({ ok: true, data: undefined }),
      listAssignments: () => Promise.resolve({ ok: true, data: [] }),
      assignToJob: () => Promise.resolve({ ok: true, data: undefined }),
      unassignFromJob: () => Promise.resolve({ ok: true, data: undefined }),
      listAssignmentsForJob: () => Promise.resolve({ ok: true, data: [] }),
      listJobOnlySkillIds: () => Promise.resolve({ ok: true, data: [] }),
      ...overrides,
    };
    return stub;
  }

  function fakeSkill(name: string, instructions: string) {
    return {
      id: `id-${name}`,
      skillId: `sid-${name}`,
      namespace: "friday",
      name,
      version: 1,
      description: "",
      descriptionManual: false,
      disabled: false,
      frontmatter: {},
      instructions,
      archive: null,
      createdBy: "system",
      createdAt: new Date(),
    } as const;
  }

  it("returns empty string when decision is 'skip'", async () => {
    _setSkillStorageForTest(mkAdapter());
    const out = await composeValidationBlock({
      decision: "skip",
      logger: mkLogger() as unknown as Parameters<typeof composeValidationBlock>[0]["logger"],
    });
    expect(out).toEqual("");
    _setSkillStorageForTest(null);
  });

  it("returns empty string when decision is 'external'", async () => {
    _setSkillStorageForTest(mkAdapter());
    const out = await composeValidationBlock({
      decision: "external",
      logger: mkLogger() as unknown as Parameters<typeof composeValidationBlock>[0]["logger"],
    });
    expect(out).toEqual("");
    _setSkillStorageForTest(null);
  });

  it("returns the default skill body when decision is 'self'", async () => {
    const body = "## Self-check rules\n- check sourcing";
    const adapter = mkAdapter({
      get: (namespace, name) => {
        expect(namespace).toEqual("friday");
        expect(name).toEqual("validating-llm-outputs");
        return Promise.resolve({ ok: true, data: fakeSkill("validating-llm-outputs", body) });
      },
    });
    _setSkillStorageForTest(adapter);

    const out = await composeValidationBlock({
      decision: "self",
      logger: mkLogger() as unknown as Parameters<typeof composeValidationBlock>[0]["logger"],
    });
    expect(out).toEqual(body);
    _setSkillStorageForTest(null);
  });

  it("loads a custom skill name when provided", async () => {
    const customName = "custom-validator";
    const body = "## Custom rules";
    const adapter = mkAdapter({
      get: (namespace, name) => {
        expect(namespace).toEqual("friday");
        expect(name).toEqual(customName);
        return Promise.resolve({ ok: true, data: fakeSkill(customName, body) });
      },
    });
    _setSkillStorageForTest(adapter);

    const out = await composeValidationBlock({
      decision: "self",
      skillName: customName,
      logger: mkLogger() as unknown as Parameters<typeof composeValidationBlock>[0]["logger"],
    });
    expect(out).toEqual(body);
    _setSkillStorageForTest(null);
  });

  it("warns and returns empty string when the requested skill is missing", async () => {
    const adapter = mkAdapter({ get: () => Promise.resolve({ ok: true, data: null }) });
    _setSkillStorageForTest(adapter);
    const logger = mkLogger();

    const out = await composeValidationBlock({
      decision: "self",
      logger: logger as unknown as Parameters<typeof composeValidationBlock>[0]["logger"],
    });
    expect(out).toEqual("");
    expect(logger.warn).toHaveBeenCalled();
    _setSkillStorageForTest(null);
  });

  it("warns and returns empty string when skill storage returns an error", async () => {
    const adapter = mkAdapter({
      get: () => Promise.resolve({ ok: false, error: "kv unavailable" }),
    });
    _setSkillStorageForTest(adapter);
    const logger = mkLogger();

    const out = await composeValidationBlock({
      decision: "self",
      logger: logger as unknown as Parameters<typeof composeValidationBlock>[0]["logger"],
    });
    expect(out).toEqual("");
    expect(logger.warn).toHaveBeenCalled();
    _setSkillStorageForTest(null);
  });

  it("warns and returns empty string when skill storage throws", async () => {
    // Distinct from the `ok: false` path: this exercises the helper's
    // try/catch (lines 289-297 of compose-blocks.ts), which mirrors
    // composeArtifactBlocks's swallow-and-log behavior so an uninitialized
    // skill catalog (common in unit-test environments) cannot block an
    // action's prompt assembly.
    const boom = new Error("skill storage not initialized");
    const adapter = mkAdapter({
      get: () => {
        throw boom;
      },
    });
    _setSkillStorageForTest(adapter);
    const logger = mkLogger();

    const out = await composeValidationBlock({
      decision: "self",
      logger: logger as unknown as Parameters<typeof composeValidationBlock>[0]["logger"],
    });
    expect(out).toEqual("");
    expect(logger.warn).toHaveBeenCalledWith(
      "composeValidationBlock: skill storage unavailable",
      expect.objectContaining({ skillName: "validating-llm-outputs" }),
    );
    _setSkillStorageForTest(null);
  });

  it("swallows a rejected promise from skill storage", async () => {
    // The async equivalent of the throw case — a get() that returns a
    // rejected promise must hit the same catch arm and degrade quietly.
    const adapter = mkAdapter({ get: () => Promise.reject(new Error("transient kv outage")) });
    _setSkillStorageForTest(adapter);
    const logger = mkLogger();

    const out = await composeValidationBlock({
      decision: "self",
      skillName: "custom-validator",
      logger: logger as unknown as Parameters<typeof composeValidationBlock>[0]["logger"],
    });
    expect(out).toEqual("");
    expect(logger.warn).toHaveBeenCalledWith(
      "composeValidationBlock: skill storage unavailable",
      expect.objectContaining({ skillName: "custom-validator" }),
    );
    _setSkillStorageForTest(null);
  });
});
