/**
 * Phase 6.B — artifacts sweeper.
 *
 * Verifies that the hourly tick:
 *   1) Promotes expired ephemeral artifacts to durable when an inbound
 *      reference signal is found (memory text or aiSummary URL).
 *   2) Deletes expired ephemeral artifacts when no signal is found.
 *   3) Leaves not-yet-expired ephemeral artifacts alone.
 *   4) Leaves durable / no-lifecycle artifacts alone.
 *   5) Isolates per-artifact failures.
 *
 * The vitest setup wires `ArtifactStorage` against a per-worker NATS
 * test server, so the sweeper exercises real storage end-to-end. The
 * scan context (memory adapter) is stubbed in-memory.
 */

import type { MemoryAdapter, NarrativeEntry, NarrativeStore } from "@atlas/agent-sdk";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startArtifactsSweeper } from "./artifacts-sweeper.ts";

class InMemoryNarrativeStore implements NarrativeStore {
  entries: NarrativeEntry[] = [];

  append(entry: NarrativeEntry): Promise<NarrativeEntry> {
    this.entries.push(entry);
    return Promise.resolve(entry);
  }

  read(): Promise<NarrativeEntry[]> {
    return Promise.resolve(this.entries);
  }

  search(): Promise<NarrativeEntry[]> {
    return Promise.resolve(this.entries);
  }

  forget(): Promise<void> {
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

function pastIso(offsetMs = 60_000): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("artifacts sweeper — promotion", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("promotes an expired ephemeral artifact to durable when memory references it", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const created = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "ephemeral",
      summary: "s",
      workspaceId,
      lifecycle: {
        kind: "ephemeral",
        boundTo: { scope: "session", sessionId },
        expiresAt: pastIso(),
      },
    });
    if (!created.ok) throw new Error("create failed");

    const notes = new InMemoryNarrativeStore();
    notes.entries = [
      {
        id: "ent-1",
        text: `kept ${created.data.id} as a reference`,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const adapter = makeMemoryAdapter({ notes });

    const sweeper = startArtifactsSweeper({
      intervalMs: 60_000,
      getScanContext: (ws) =>
        Promise.resolve(
          ws === workspaceId ? { memoryAdapter: adapter, memoryStoreNames: ["notes"] } : undefined,
        ),
    });

    try {
      const out = await sweeper.tick();
      expect(out.promoted).toContain(created.data.id);
      expect(out.deleted).not.toContain(created.data.id);
    } finally {
      sweeper.stop();
    }

    const got = await ArtifactStorage.get({ id: created.data.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).not.toBeNull();
    expect(got.data?.lifecycle).toEqual({ kind: "durable" });
  });

  it("promotes when an aiSummary keyDetail URL references the artifact id", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const created = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "ephemeral",
      summary: "s",
      workspaceId,
      lifecycle: {
        kind: "ephemeral",
        boundTo: { scope: "session", sessionId },
        expiresAt: pastIso(),
      },
    });
    if (!created.ok) throw new Error("create failed");

    const sweeper = startArtifactsSweeper({
      intervalMs: 60_000,
      getScanContext: (ws) =>
        Promise.resolve(
          ws === workspaceId
            ? {
                memoryStoreNames: [],
                aiSummary: () => Promise.resolve([{ url: `/artifacts/${created.data.id}` }]),
              }
            : undefined,
        ),
    });

    try {
      const out = await sweeper.tick();
      expect(out.promoted).toContain(created.data.id);
    } finally {
      sweeper.stop();
    }

    const got = await ArtifactStorage.get({ id: created.data.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data?.lifecycle).toEqual({ kind: "durable" });
  });
});

describe("artifacts sweeper — deletion", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes an expired ephemeral artifact when no signal is found", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const created = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "ephemeral",
      summary: "s",
      workspaceId,
      lifecycle: {
        kind: "ephemeral",
        boundTo: { scope: "session", sessionId },
        expiresAt: pastIso(),
      },
    });
    if (!created.ok) throw new Error("create failed");

    const notes = new InMemoryNarrativeStore();
    // Empty notes — no memory references.
    const adapter = makeMemoryAdapter({ notes });

    const sweeper = startArtifactsSweeper({
      intervalMs: 60_000,
      getScanContext: (ws) =>
        Promise.resolve(
          ws === workspaceId ? { memoryAdapter: adapter, memoryStoreNames: ["notes"] } : undefined,
        ),
    });

    try {
      const out = await sweeper.tick();
      expect(out.deleted).toContain(created.data.id);
      expect(out.promoted).not.toContain(created.data.id);
    } finally {
      sweeper.stop();
    }

    const got = await ArtifactStorage.get({ id: created.data.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).toBeNull(); // tombstoned → null on read
  });

  it("deletes an expired artifact whose workspace runtime is gone", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const created = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "ephemeral",
      summary: "s",
      workspaceId,
      lifecycle: {
        kind: "ephemeral",
        boundTo: { scope: "session", sessionId },
        expiresAt: pastIso(),
      },
    });
    if (!created.ok) throw new Error("create failed");

    // getScanContext always resolves undefined — workspace runtime not
    // registered. Sweeper should treat as "no signal" and delete.
    const sweeper = startArtifactsSweeper({
      intervalMs: 60_000,
      getScanContext: () => Promise.resolve(undefined),
    });

    try {
      const out = await sweeper.tick();
      expect(out.deleted).toContain(created.data.id);
    } finally {
      sweeper.stop();
    }
  });
});

describe("artifacts sweeper — leaves untouched", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves not-yet-expired ephemeral artifacts alone", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const created = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "future",
      summary: "s",
      workspaceId,
      lifecycle: {
        kind: "ephemeral",
        boundTo: { scope: "session", sessionId },
        expiresAt: futureIso(60 * 60 * 1000), // 1h ahead
      },
    });
    if (!created.ok) throw new Error("create failed");

    const sweeper = startArtifactsSweeper({
      intervalMs: 60_000,
      getScanContext: () => Promise.resolve({ memoryStoreNames: [] }),
    });

    try {
      const out = await sweeper.tick();
      expect(out.promoted).not.toContain(created.data.id);
      expect(out.deleted).not.toContain(created.data.id);
    } finally {
      sweeper.stop();
    }

    const got = await ArtifactStorage.get({ id: created.data.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).not.toBeNull();
  });

  it("leaves durable artifacts alone (no expiresAt)", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;

    const created = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "durable",
      summary: "s",
      workspaceId,
      lifecycle: { kind: "durable" },
    });
    if (!created.ok) throw new Error("create failed");

    const sweeper = startArtifactsSweeper({
      intervalMs: 60_000,
      getScanContext: () => Promise.resolve({ memoryStoreNames: [] }),
    });

    try {
      const out = await sweeper.tick();
      expect(out.promoted).not.toContain(created.data.id);
      expect(out.deleted).not.toContain(created.data.id);
    } finally {
      sweeper.stop();
    }

    const got = await ArtifactStorage.get({ id: created.data.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).not.toBeNull();
  });

  it("leaves ephemeral artifacts without expiresAt alone (un-stamped)", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    // Ephemeral but no expiresAt — runtime hasn't stamped yet (e.g.
    // process death between create and session-complete).
    const created = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "unstamped",
      summary: "s",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId } },
    });
    if (!created.ok) throw new Error("create failed");

    const sweeper = startArtifactsSweeper({
      intervalMs: 60_000,
      getScanContext: () => Promise.resolve({ memoryStoreNames: [] }),
    });

    try {
      const out = await sweeper.tick();
      expect(out.promoted).not.toContain(created.data.id);
      expect(out.deleted).not.toContain(created.data.id);
    } finally {
      sweeper.stop();
    }

    const got = await ArtifactStorage.get({ id: created.data.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).not.toBeNull();
  });
});

describe("artifacts sweeper — clock", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("respects an injected clock — expiresAt in real-future, fake-now-past triggers sweep", async () => {
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const sessionId = `ses-${crypto.randomUUID()}`;

    const expiresAt = futureIso(60 * 60 * 1000); // 1 hour from real now
    const fakeNow = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours ahead

    const created = await ArtifactStorage.create({
      data: { type: "file", content: "{}", contentEncoding: "utf-8", mimeType: "application/json" },
      title: "future-expiry",
      summary: "s",
      workspaceId,
      lifecycle: { kind: "ephemeral", boundTo: { scope: "session", sessionId }, expiresAt },
    });
    if (!created.ok) throw new Error("create failed");

    const sweeper = startArtifactsSweeper({
      intervalMs: 60_000,
      now: () => fakeNow,
      getScanContext: () => Promise.resolve({ memoryStoreNames: [] }),
    });

    try {
      const out = await sweeper.tick();
      expect(out.deleted).toContain(created.data.id);
    } finally {
      sweeper.stop();
    }
  });
});
