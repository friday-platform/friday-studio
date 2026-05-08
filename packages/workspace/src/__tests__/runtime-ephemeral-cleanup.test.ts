/**
 * Phase 6.B — at session-complete, ephemeral artifacts get an
 * `expiresAt` stamp (sweeper picks them up later) and ephemeral memory
 * entries get forgotten synchronously (notes are genuinely short-term;
 * memory has no promotion-by-reference signal of its own).
 *
 * Verifies that the free function `expireEphemeralForSession` (extracted
 * from {@link WorkspaceRuntime} so the test doesn't have to spin the
 * runtime up):
 *
 *   1. Stamps `expiresAt = completedAt + graceMs` on artifacts whose
 *      `lifecycle.boundTo.sessionId` matches the completed session.
 *   2. Leaves durable artifacts and ephemeral artifacts bound to other
 *      sessions alone.
 *   3. Calls `forget()` on memory entries whose lifecycle binds to the
 *      completed session and skips the rest.
 *
 * The vitest setup initializes `ArtifactStorage` against a per-worker
 * NATS test server, so artifact reads/writes are real. The narrative
 * memory adapter is stubbed in-memory.
 */

import type { MemoryAdapter, NarrativeEntry, NarrativeStore } from "@atlas/agent-sdk";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expireEphemeralForSession } from "../runtime.ts";

const GRACE_MS = 24 * 60 * 60 * 1000;

class InMemoryNarrativeStore implements NarrativeStore {
  entries: NarrativeEntry[] = [];
  forgotten: string[] = [];

  append(entry: NarrativeEntry): Promise<NarrativeEntry> {
    this.entries.push(entry);
    return Promise.resolve(entry);
  }

  read(): Promise<NarrativeEntry[]> {
    return Promise.resolve(this.entries.filter((e) => !this.forgotten.includes(e.id)));
  }

  search(): Promise<NarrativeEntry[]> {
    return this.read();
  }

  forget(id: string): Promise<void> {
    this.forgotten.push(id);
    return Promise.resolve();
  }

  render(): Promise<string> {
    return Promise.resolve("");
  }
}

function makeMemoryAdapter(stores: Record<string, InMemoryNarrativeStore>): MemoryAdapter {
  return {
    store(_workspaceId: string, name: string): Promise<NarrativeStore> {
      const s = stores[name];
      if (!s) return Promise.reject(new Error(`unknown store ${name}`));
      return Promise.resolve(s);
    },
    list: () => Promise.resolve([]),
    bootstrap: () => Promise.resolve(""),
    history: () => Promise.resolve([]),
    rollback: () => Promise.resolve(),
  };
}

describe("expireEphemeralForSession — artifacts", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps expiresAt on ephemeral artifacts bound to the completed session", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;
    const completedAt = new Date("2026-05-05T00:00:00.000Z");

    const ephemeral = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "ephemeral",
      summary: "s",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
    });
    if (!ephemeral.ok) throw new Error("create failed");

    await expireEphemeralForSession({
      sessionId,
      jobName: "j",
      workspaceId,
      completedAt,
      graceMs: GRACE_MS,
      memoryStoreNames: [],
    });

    const fetched = await ArtifactStorage.get({ id: ephemeral.data.id });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok || !fetched.data) throw new Error("expected artifact");
    // Still present — the sweeper does the eventual delete.
    expect(fetched.data).not.toBeNull();
    const lc = fetched.data.lifecycle;
    expect(lc?.kind).toBe("ephemeral");
    if (lc?.kind !== "ephemeral") return;
    const expectedExpiry = new Date(completedAt.getTime() + GRACE_MS).toISOString();
    expect(lc.expiresAt).toBe(expectedExpiry);
    expect(lc.boundTo).toEqual({ scope: "session", sessionId });
  });

  it("leaves durable artifacts in this workspace untouched", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const durable = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "durable",
      summary: "s",
      workspaceId,
      lifecycle: { kind: "durable" },
    });
    if (!durable.ok) throw new Error("create failed");

    await expireEphemeralForSession({
      sessionId,
      jobName: "j",
      workspaceId,
      completedAt: new Date(),
      graceMs: GRACE_MS,
      memoryStoreNames: [],
    });

    const fetched = await ArtifactStorage.get({ id: durable.data.id });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data).not.toBeNull();
    expect(fetched.data?.lifecycle).toEqual({ kind: "durable" });
  });

  it("leaves ephemeral artifacts bound to a different session alone", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;
    const otherSessionId = `ses-${crypto.randomUUID()}`;

    const otherEphemeral = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "other",
      summary: "s",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId: otherSessionId } },
    });
    if (!otherEphemeral.ok) throw new Error("create failed");

    await expireEphemeralForSession({
      sessionId,
      jobName: "j",
      workspaceId,
      completedAt: new Date(),
      graceMs: GRACE_MS,
      memoryStoreNames: [],
    });

    const fetched = await ArtifactStorage.get({ id: otherEphemeral.data.id });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok || !fetched.data) throw new Error("expected artifact");
    const lc = fetched.data.lifecycle;
    if (lc?.kind !== "ephemeral") throw new Error("expected ephemeral");
    expect(lc.expiresAt).toBeUndefined();
  });

  it("leaves artifacts with no lifecycle field (pre-Phase-6) untouched", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const legacy = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "legacy",
      summary: "s",
      workspaceId,
    });
    if (!legacy.ok) throw new Error("create failed");

    await expireEphemeralForSession({
      sessionId,
      jobName: "j",
      workspaceId,
      completedAt: new Date(),
      graceMs: GRACE_MS,
      memoryStoreNames: [],
    });

    const fetched = await ArtifactStorage.get({ id: legacy.data.id });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data).not.toBeNull();
    expect(fetched.data?.lifecycle).toBeUndefined();
  });
});

describe("expireEphemeralForSession — memory", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forgets ephemeral memory entries bound to the completed session", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const notesStore = new InMemoryNarrativeStore();
    notesStore.entries = [
      {
        id: "ent-bound",
        text: "ephemeral note",
        createdAt: "2026-01-01T00:00:00.000Z",
        lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
      },
      {
        id: "ent-other",
        text: "ephemeral note bound to a different session",
        createdAt: "2026-01-01T00:00:00.000Z",
        lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId: "ses-other" } },
      },
      {
        id: "ent-durable",
        text: "durable note",
        createdAt: "2026-01-01T00:00:00.000Z",
        lifecycle: { kind: "durable" },
      },
      { id: "ent-legacy", text: "no lifecycle field", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    const adapter = makeMemoryAdapter({ notes: notesStore });

    await expireEphemeralForSession({
      sessionId,
      jobName: "j",
      workspaceId,
      completedAt: new Date(),
      graceMs: GRACE_MS,
      memoryAdapter: adapter,
      memoryStoreNames: ["notes"],
    });

    expect(notesStore.forgotten).toEqual(["ent-bound"]);
  });

  it("is a no-op when no memory adapter is supplied", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    // Should not throw without a memory adapter.
    await expireEphemeralForSession({
      sessionId,
      jobName: "j",
      workspaceId,
      completedAt: new Date(),
      graceMs: GRACE_MS,
      memoryStoreNames: ["notes"],
    });
  });

  it("isolates failures per store — one bad store does not block the next", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const goodStore = new InMemoryNarrativeStore();
    goodStore.entries = [
      {
        id: "ent",
        text: "x",
        createdAt: "2026-01-01T00:00:00.000Z",
        lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
      },
    ];

    // Adapter throws when asked for the unknown store, but should still
    // process the second one.
    const adapter: MemoryAdapter = {
      store(_ws: string, name: string): Promise<NarrativeStore> {
        if (name === "broken") return Promise.reject(new Error("store unavailable"));
        return Promise.resolve(goodStore);
      },
      list: () => Promise.resolve([]),
      bootstrap: () => Promise.resolve(""),
      history: () => Promise.resolve([]),
      rollback: () => Promise.resolve(),
    };

    await expireEphemeralForSession({
      sessionId,
      jobName: "j",
      workspaceId,
      completedAt: new Date(),
      graceMs: GRACE_MS,
      memoryAdapter: adapter,
      memoryStoreNames: ["broken", "notes"],
    });

    expect(goodStore.forgotten).toEqual(["ent"]);
  });
});
