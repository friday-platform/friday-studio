import type {
  CorpusKind,
  CorpusMetadata,
  CorpusOf,
  HistoryEntry,
  HistoryFilter,
  MemoryAdapter,
  NarrativeCorpus,
  NarrativeEntry,
} from "@atlas/agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryMount } from "../config-schema.ts";
import { MountSourceNotFoundError } from "../mount-errors.ts";
import { mountRegistry } from "../mount-registry.ts";
import { MountedCorpusBinding } from "../mounted-corpus-binding.ts";

function createMockCorpus(): NarrativeCorpus {
  return {
    append: vi
      .fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>()
      .mockImplementation((entry) => Promise.resolve(entry)),
    read: vi
      .fn<(opts?: { since?: string; limit?: number }) => Promise<NarrativeEntry[]>>()
      .mockResolvedValue([]),
    search: vi.fn<(query: string) => Promise<NarrativeEntry[]>>().mockResolvedValue([]),
    forget: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    render: vi.fn<() => Promise<string>>().mockResolvedValue(""),
  };
}

function createMockAdapter(corpusOrNull?: NarrativeCorpus | null): MemoryAdapter {
  const corpus = corpusOrNull === null ? undefined : (corpusOrNull ?? createMockCorpus());
  return {
    corpus<K extends CorpusKind>(_wsId: string, _name: string, _kind: K): Promise<CorpusOf<K>> {
      if (!corpus) {
        return Promise.reject(new Error("Corpus not found"));
      }
      return Promise.resolve(corpus as CorpusOf<K>);
    },
    list: vi.fn<(_wsId: string) => Promise<CorpusMetadata[]>>().mockResolvedValue([]),
    bootstrap: vi.fn<(_wsId: string, _agentId: string) => Promise<string>>().mockResolvedValue(""),
    history: vi
      .fn<(_wsId: string, _filter?: HistoryFilter) => Promise<HistoryEntry[]>>()
      .mockResolvedValue([]),
    rollback: vi
      .fn<(_wsId: string, _corpus: string, _toVersion: string) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
}

function validMount(overrides: Partial<MemoryMount> = {}): MemoryMount {
  return {
    name: "backlog",
    source: "_global/narrative/autopilot-backlog",
    mode: "ro",
    scope: "workspace",
    ...overrides,
  };
}

describe("runtime mount resolution (unit)", () => {
  beforeEach(() => {
    mountRegistry.clear();
  });

  afterEach(() => {
    mountRegistry.clear();
  });

  it("valid mounts parse and bind without error", async () => {
    const corpus = createMockCorpus();
    const adapter = createMockAdapter(corpus);
    const mount = validMount();

    mountRegistry.registerSource(mount.source, () =>
      adapter.corpus("_global", "autopilot-backlog", "narrative"),
    );
    mountRegistry.addConsumer(mount.source, "test-ws");

    const resolvedCorpus = await adapter.corpus("_global", "autopilot-backlog", "narrative");

    const binding = new MountedCorpusBinding({
      name: mount.name,
      source: mount.source,
      mode: mount.mode,
      scope: mount.scope,
      scopeTarget: mount.scopeTarget,
      read: (filter) => resolvedCorpus.read(filter),
      append: (entry) => resolvedCorpus.append(entry),
    });

    expect(binding.name).toBe("backlog");
    expect(binding.source).toBe("_global/narrative/autopilot-backlog");
    expect(binding.mode).toBe("ro");
  });

  it("missing source corpus throws MountSourceNotFoundError", async () => {
    await expect(mountRegistry.resolve("nonexistent/narrative/missing")).rejects.toThrow(
      MountSourceNotFoundError,
    );
  });

  it("MountSourceNotFoundError has descriptive message", async () => {
    try {
      await mountRegistry.resolve("nonexistent/narrative/missing");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MountSourceNotFoundError);
      if (err instanceof MountSourceNotFoundError) {
        expect(err.message).toContain("nonexistent/narrative/missing");
      }
    }
  });

  describe("scope filtering", () => {
    function buildBindings(): MountedCorpusBinding[] {
      const mockRead = () => Promise.resolve([]);
      const mockAppend = (e: NarrativeEntry) => Promise.resolve(e);
      return [
        new MountedCorpusBinding({
          name: "ws-mount",
          source: "_global/narrative/shared",
          mode: "ro",
          scope: "workspace",
          read: mockRead,
          append: mockAppend,
        }),
        new MountedCorpusBinding({
          name: "job-mount",
          source: "_global/narrative/job-data",
          mode: "rw",
          scope: "job",
          scopeTarget: "process-signals",
          read: mockRead,
          append: mockAppend,
        }),
        new MountedCorpusBinding({
          name: "agent-mount",
          source: "_global/narrative/agent-private",
          mode: "ro",
          scope: "agent",
          scopeTarget: "planner",
          read: mockRead,
          append: mockAppend,
        }),
      ];
    }

    function getMountsForAgent(
      bindings: MountedCorpusBinding[],
      agentId: string,
      jobName?: string,
    ): Record<string, MountedCorpusBinding> {
      const result: Record<string, MountedCorpusBinding> = {};
      for (const binding of bindings) {
        switch (binding.scope) {
          case "workspace":
            result[binding.name] = binding;
            break;
          case "job":
            if (jobName && binding.scopeTarget === jobName) {
              result[binding.name] = binding;
            }
            break;
          case "agent":
            if (binding.scopeTarget === agentId) {
              result[binding.name] = binding;
            }
            break;
        }
      }
      return result;
    }

    it("workspace-scope mounts appear on ALL agent contexts", () => {
      const bindings = buildBindings();
      const mountsA = getMountsForAgent(bindings, "planner", "process-signals");
      const mountsB = getMountsForAgent(bindings, "reviewer", "handle-chat");

      expect(mountsA["ws-mount"]).toBeDefined();
      expect(mountsB["ws-mount"]).toBeDefined();
    });

    it("job-scope mounts appear only on agents with matching jobName", () => {
      const bindings = buildBindings();
      const matchingMounts = getMountsForAgent(bindings, "planner", "process-signals");
      const nonMatchingMounts = getMountsForAgent(bindings, "planner", "handle-chat");

      expect(matchingMounts["job-mount"]).toBeDefined();
      expect(nonMatchingMounts["job-mount"]).toBeUndefined();
    });

    it("agent-scope mounts appear only on the specific agent", () => {
      const bindings = buildBindings();
      const plannerMounts = getMountsForAgent(bindings, "planner", "process-signals");
      const reviewerMounts = getMountsForAgent(bindings, "reviewer", "process-signals");

      expect(plannerMounts["agent-mount"]).toBeDefined();
      expect(reviewerMounts["agent-mount"]).toBeUndefined();
    });
  });
});
