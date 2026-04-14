import type { NarrativeEntry } from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { MountReadonlyError } from "../mount-errors.ts";
import type { MountFilter } from "../mounted-corpus-binding.ts";
import { MountedCorpusBinding } from "../mounted-corpus-binding.ts";

const ENTRY: NarrativeEntry = { id: "e-1", text: "test entry", createdAt: "2026-04-14T00:00:00Z" };

describe("MountedCorpusBinding", () => {
  describe("read()", () => {
    it("delegates to the underlying read function", async () => {
      const readFn = vi
        .fn<(filter?: MountFilter) => Promise<NarrativeEntry[]>>()
        .mockResolvedValue([ENTRY]);
      const binding = new MountedCorpusBinding({
        name: "backlog",
        source: "_global/narrative/backlog",
        mode: "ro",
        scope: "workspace",
        read: readFn,
        append: vi.fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>(),
      });

      const result = await binding.read({ since: "2026-01-01T00:00:00Z" });
      expect(result).toEqual([ENTRY]);
      expect(readFn).toHaveBeenCalledWith({ since: "2026-01-01T00:00:00Z" });
    });

    it("passes undefined filter when no args", async () => {
      const readFn = vi
        .fn<(filter?: MountFilter) => Promise<NarrativeEntry[]>>()
        .mockResolvedValue([]);
      const binding = new MountedCorpusBinding({
        name: "backlog",
        source: "_global/narrative/backlog",
        mode: "ro",
        scope: "workspace",
        read: readFn,
        append: vi.fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>(),
      });

      await binding.read();
      expect(readFn).toHaveBeenCalledWith(undefined);
    });
  });

  describe("append() with mode='ro'", () => {
    it("throws MountReadonlyError", () => {
      const binding = new MountedCorpusBinding({
        name: "readonly-mount",
        source: "ws-1/narrative/logs",
        mode: "ro",
        scope: "workspace",
        read: vi.fn<(filter?: MountFilter) => Promise<NarrativeEntry[]>>(),
        append: vi.fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>(),
      });

      expect(() => binding.append(ENTRY)).toThrow(MountReadonlyError);
    });

    it("thrown error includes mount name", () => {
      const binding = new MountedCorpusBinding({
        name: "readonly-mount",
        source: "ws-1/narrative/logs",
        mode: "ro",
        scope: "workspace",
        read: vi.fn<(filter?: MountFilter) => Promise<NarrativeEntry[]>>(),
        append: vi.fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>(),
      });

      try {
        binding.append(ENTRY);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MountReadonlyError);
        if (err instanceof MountReadonlyError) {
          expect(err.message).toContain("readonly-mount");
          expect(err.code).toBe("MOUNT_READONLY");
        }
      }
    });
  });

  describe("append() with mode='rw'", () => {
    it("delegates to underlying append function", async () => {
      const appendFn = vi
        .fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>()
        .mockResolvedValue(ENTRY);
      const binding = new MountedCorpusBinding({
        name: "writable-mount",
        source: "ws-1/narrative/logs",
        mode: "rw",
        scope: "workspace",
        read: vi.fn<(filter?: MountFilter) => Promise<NarrativeEntry[]>>(),
        append: appendFn,
      });

      const result = await binding.append(ENTRY);
      expect(result).toEqual(ENTRY);
      expect(appendFn).toHaveBeenCalledWith(ENTRY);
    });
  });

  describe("properties", () => {
    it("exposes all readonly properties", () => {
      const binding = new MountedCorpusBinding({
        name: "scoped-mount",
        source: "ws-1/narrative/logs",
        mode: "rw",
        scope: "agent",
        scopeTarget: "planner",
        read: vi.fn<(filter?: MountFilter) => Promise<NarrativeEntry[]>>(),
        append: vi.fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>(),
      });

      expect(binding.name).toBe("scoped-mount");
      expect(binding.source).toBe("ws-1/narrative/logs");
      expect(binding.mode).toBe("rw");
      expect(binding.scope).toBe("agent");
      expect(binding.scopeTarget).toBe("planner");
    });
  });
});
