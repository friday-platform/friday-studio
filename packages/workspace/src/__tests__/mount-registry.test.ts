import type { NarrativeCorpus, NarrativeEntry } from "@atlas/agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MountSourceNotFoundError } from "../mount-errors.ts";
import { mountRegistry } from "../mount-registry.ts";

function createStubNarrativeCorpus(): NarrativeCorpus {
  return {
    append: vi
      .fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>()
      .mockResolvedValue({ id: "1", text: "test", createdAt: new Date().toISOString() }),
    read: vi
      .fn<(opts?: { since?: string; limit?: number }) => Promise<NarrativeEntry[]>>()
      .mockResolvedValue([]),
    search: vi.fn<(query: string) => Promise<NarrativeEntry[]>>().mockResolvedValue([]),
    forget: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    render: vi.fn<() => Promise<string>>().mockResolvedValue(""),
  };
}

describe("mountRegistry", () => {
  beforeEach(() => {
    mountRegistry.clear();
  });

  afterEach(() => {
    mountRegistry.clear();
  });

  describe("registerSource", () => {
    it("registers a source with a resolver", () => {
      const corpus = createStubNarrativeCorpus();
      mountRegistry.registerSource("ws-1/narrative/logs", () => Promise.resolve(corpus));
      expect(mountRegistry.hasSource("ws-1/narrative/logs")).toBe(true);
    });

    it("is idempotent — second registration does not overwrite", async () => {
      const corpus1 = createStubNarrativeCorpus();
      const corpus2 = createStubNarrativeCorpus();
      mountRegistry.registerSource("src-1", () => Promise.resolve(corpus1));
      mountRegistry.registerSource("src-1", () => Promise.resolve(corpus2));

      const resolved = await mountRegistry.resolve("src-1");
      expect(resolved).toBe(corpus1);
    });
  });

  describe("addConsumer", () => {
    it("tracks workspaceIds for a source", () => {
      mountRegistry.registerSource("src-1", () => Promise.resolve(createStubNarrativeCorpus()));
      mountRegistry.addConsumer("src-1", "ws-a");
      mountRegistry.addConsumer("src-1", "ws-b");

      const consumers = mountRegistry.getConsumers("src-1");
      expect(consumers.has("ws-a")).toBe(true);
      expect(consumers.has("ws-b")).toBe(true);
      expect(consumers.size).toBe(2);
    });

    it("tracks multiple workspaces across sources", () => {
      mountRegistry.registerSource("src-1", () => Promise.resolve(createStubNarrativeCorpus()));
      mountRegistry.registerSource("src-2", () => Promise.resolve(createStubNarrativeCorpus()));

      mountRegistry.addConsumer("src-1", "ws-a");
      mountRegistry.addConsumer("src-2", "ws-b");

      expect(mountRegistry.getConsumers("src-1").has("ws-a")).toBe(true);
      expect(mountRegistry.getConsumers("src-2").has("ws-b")).toBe(true);
    });

    it("adding same consumer twice is idempotent", () => {
      mountRegistry.registerSource("src-1", () => Promise.resolve(createStubNarrativeCorpus()));
      mountRegistry.addConsumer("src-1", "ws-a");
      mountRegistry.addConsumer("src-1", "ws-a");

      expect(mountRegistry.getConsumers("src-1").size).toBe(1);
    });
  });

  describe("resolve", () => {
    it("returns the corpus from the resolver", async () => {
      const corpus = createStubNarrativeCorpus();
      mountRegistry.registerSource("src-1", () => Promise.resolve(corpus));
      const result = await mountRegistry.resolve("src-1");
      expect(result).toBe(corpus);
    });

    it("throws MountSourceNotFoundError for unknown source", async () => {
      await expect(mountRegistry.resolve("nonexistent")).rejects.toThrow(MountSourceNotFoundError);
    });

    it("thrown error has correct code", async () => {
      try {
        await mountRegistry.resolve("nonexistent");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MountSourceNotFoundError);
        if (err instanceof MountSourceNotFoundError) {
          expect(err.code).toBe("MOUNT_SOURCE_NOT_FOUND");
        }
      }
    });
  });

  describe("clear", () => {
    it("removes all sources and consumers", () => {
      mountRegistry.registerSource("src-1", () => Promise.resolve(createStubNarrativeCorpus()));
      mountRegistry.addConsumer("src-1", "ws-a");

      mountRegistry.clear();

      expect(mountRegistry.hasSource("src-1")).toBe(false);
      expect(mountRegistry.getConsumers("src-1").size).toBe(0);
    });
  });
});
