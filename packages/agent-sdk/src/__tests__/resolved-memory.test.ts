import { describe, expect, it } from "vitest";
import type { MountDeclaration } from "../memory-scope.ts";
import {
  buildResolvedWorkspaceMemory,
  type ResolvedMount,
  ResolvedMountSchema,
  type ResolvedOwnCorpus,
  ResolvedOwnCorpusSchema,
  type ResolvedWorkspaceMemory,
  ResolvedWorkspaceMemorySchema,
  type ScopeTag,
} from "../resolved-memory.ts";

describe("ResolvedWorkspaceMemory type contracts", () => {
  it("composes own + mounts + globalAccess", () => {
    const resolved: ResolvedWorkspaceMemory = {
      workspaceId: "braised_biscuit",
      own: [
        { name: "notes", type: "short_term", scope: "workspace" },
        { name: "backlog", type: "long_term", strategy: "narrative", scope: "workspace" },
      ],
      mounts: [
        {
          name: "shared-orders",
          source: "_global/narrative/orders",
          mode: "ro",
          scope: "workspace",
          sourceWorkspaceId: "_global",
          sourceCorpusKind: "narrative",
          sourceCorpusName: "orders",
        },
      ],
      globalAccess: { canRead: true, canWrite: false },
    };

    expect(resolved.own).toHaveLength(2);
    expect(resolved.mounts).toHaveLength(1);
    expect(resolved.globalAccess.canRead).toBe(true);
    expect(resolved.globalAccess.canWrite).toBe(false);
  });

  it("ResolvedOwnCorpus scope is always 'workspace'", () => {
    const own: ResolvedOwnCorpus = {
      name: "test",
      type: "long_term",
      strategy: "narrative",
      scope: "workspace",
    };
    expect(own.scope).toBe("workspace");
  });

  it("ResolvedMount carries parsed source components", () => {
    const mount: ResolvedMount = {
      name: "reflections",
      source: "thick_endive/narrative/reflections",
      mode: "ro",
      scope: "workspace",
      sourceWorkspaceId: "thick_endive",
      sourceCorpusKind: "narrative",
      sourceCorpusName: "reflections",
    };
    expect(mount.sourceWorkspaceId).toBe("thick_endive");
    expect(mount.sourceCorpusKind).toBe("narrative");
    expect(mount.sourceCorpusName).toBe("reflections");
  });

  it("ResolvedMount inherits MountDeclaration shape fields", () => {
    const decl: MountDeclaration = {
      name: "test-mount",
      source: "ws1/narrative/corpus1",
      mode: "rw",
      scope: "agent",
      scopeTarget: "my-agent",
    };
    const mount: ResolvedMount = {
      ...decl,
      sourceWorkspaceId: "ws1",
      sourceCorpusKind: "narrative",
      sourceCorpusName: "corpus1",
    };
    expect(mount.name).toBe(decl.name);
    expect(mount.source).toBe(decl.source);
    expect(mount.mode).toBe(decl.mode);
    expect(mount.scope).toBe(decl.scope);
    expect(mount.scopeTarget).toBe(decl.scopeTarget);
  });
});

describe("ScopeTag discriminated union", () => {
  it("covers all three scope values", () => {
    const tags: ScopeTag[] = ["global", "workspace", "mounted"];
    expect(tags).toHaveLength(3);
  });

  it("exhaustiveness check via function", () => {
    function describeScopeTag(tag: ScopeTag): string {
      switch (tag) {
        case "global":
          return "global";
        case "workspace":
          return "workspace";
        case "mounted":
          return "mounted";
      }
    }
    expect(describeScopeTag("global")).toBe("global");
    expect(describeScopeTag("workspace")).toBe("workspace");
    expect(describeScopeTag("mounted")).toBe("mounted");
  });
});

describe("Zod schema validation", () => {
  it("ResolvedOwnCorpusSchema accepts valid own entry", () => {
    const result = ResolvedOwnCorpusSchema.safeParse({
      name: "backlog",
      type: "long_term",
      strategy: "narrative",
      scope: "workspace",
    });
    expect(result.success).toBe(true);
  });

  it("ResolvedOwnCorpusSchema rejects invalid scope", () => {
    const result = ResolvedOwnCorpusSchema.safeParse({
      name: "backlog",
      type: "long_term",
      scope: "global",
    });
    expect(result.success).toBe(false);
  });

  it("ResolvedMountSchema accepts valid mount", () => {
    const result = ResolvedMountSchema.safeParse({
      name: "shared",
      source: "_global/narrative/orders",
      mode: "ro",
      scope: "workspace",
      sourceWorkspaceId: "_global",
      sourceCorpusKind: "narrative",
      sourceCorpusName: "orders",
    });
    expect(result.success).toBe(true);
  });

  it("ResolvedWorkspaceMemorySchema accepts full resolved memory", () => {
    const result = ResolvedWorkspaceMemorySchema.safeParse({
      workspaceId: "test_ws",
      own: [{ name: "notes", type: "short_term", scope: "workspace" }],
      mounts: [],
      globalAccess: { canRead: false, canWrite: false },
    });
    expect(result.success).toBe(true);
  });
});

describe("buildResolvedWorkspaceMemory", () => {
  it("builds from own entries and mount declarations", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [
        { name: "notes", type: "short_term" },
        { name: "backlog", type: "long_term", strategy: "narrative" },
      ],
      mountDeclarations: [
        {
          name: "shared-orders",
          source: "_global/narrative/orders",
          mode: "ro",
          scope: "workspace",
        },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.workspaceId).toBe("braised_biscuit");
    expect(resolved.own).toHaveLength(2);
    expect(resolved.own[0]?.scope).toBe("workspace");
    expect(resolved.mounts).toHaveLength(1);
    expect(resolved.mounts[0]?.sourceWorkspaceId).toBe("_global");
    expect(resolved.mounts[0]?.sourceCorpusKind).toBe("narrative");
    expect(resolved.mounts[0]?.sourceCorpusName).toBe("orders");
    expect(resolved.globalAccess.canRead).toBe(true);
    expect(resolved.globalAccess.canWrite).toBe(false);
  });

  it("sets canWrite=true only when workspace is kernel and has rw global mount", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "thick_endive",
      ownEntries: [],
      mountDeclarations: [
        { name: "global-rw", source: "_global/narrative/orders", mode: "rw", scope: "workspace" },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.globalAccess.canRead).toBe(true);
    expect(resolved.globalAccess.canWrite).toBe(true);
  });

  it("sets canWrite=false for non-kernel workspace even with rw global mount", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [
        { name: "global-rw", source: "_global/narrative/orders", mode: "rw", scope: "workspace" },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.globalAccess.canRead).toBe(true);
    expect(resolved.globalAccess.canWrite).toBe(false);
  });

  it("returns empty state when no own entries or mounts", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "empty_ws",
      ownEntries: [],
      mountDeclarations: [],
      kernelWorkspaceId: undefined,
    });

    expect(resolved.own).toHaveLength(0);
    expect(resolved.mounts).toHaveLength(0);
    expect(resolved.globalAccess.canRead).toBe(false);
    expect(resolved.globalAccess.canWrite).toBe(false);
  });
});
