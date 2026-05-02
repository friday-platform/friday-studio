import { describe, expect, it } from "vitest";

import {
  ALL_SCOPES,
  GLOBAL_WORKSPACE_ID,
  isGlobalScope,
  type MemoryScope,
  type MemoryScopeDescriptor,
  type MountDeclaration,
  resolveMemoryBasePath,
  SCOPE_ACCESS_RULES,
} from "../memory-scope.ts";
import { buildResolvedWorkspaceMemory } from "../resolved-memory.ts";

// ── Contract guards ──────────────────────────────────────────────────────

describe("contract guards", () => {
  it("GLOBAL_WORKSPACE_ID equals '_global'", () => {
    expect(GLOBAL_WORKSPACE_ID).toBe("_global");
  });

  it("isGlobalScope returns true for '_global' and false for any other string", () => {
    expect(isGlobalScope("_global")).toBe(true);
    expect(isGlobalScope(GLOBAL_WORKSPACE_ID)).toBe(true);

    expect(isGlobalScope("braised_biscuit")).toBe(false);
    expect(isGlobalScope("global")).toBe(false);
    expect(isGlobalScope("_Global")).toBe(false);
    expect(isGlobalScope("")).toBe(false);
  });

  it("resolveMemoryBasePath returns 'memory/_global/' for global scope", () => {
    expect(resolveMemoryBasePath("_global")).toBe("memory/_global/");
    expect(resolveMemoryBasePath(GLOBAL_WORKSPACE_ID)).toBe("memory/_global/");
  });

  it("resolveMemoryBasePath returns 'memory/{wsId}/' for workspace scope", () => {
    expect(resolveMemoryBasePath("braised_biscuit")).toBe("memory/braised_biscuit/");
    expect(resolveMemoryBasePath("thick_endive")).toBe("memory/thick_endive/");
  });
});

// ── ALL_SCOPES exhaustiveness ────────────────────────────────────────────

describe("ALL_SCOPES", () => {
  it("tuple is exhaustive over MemoryScope", () => {
    const fromTuple: readonly MemoryScope[] = ALL_SCOPES;
    expect(fromTuple).toEqual(["global", "workspace", "mounted"]);

    const typeCheck: (typeof ALL_SCOPES)[number] extends MemoryScope ? true : false = true;
    expect(typeCheck).toBe(true);
  });

  it("contains exactly three entries", () => {
    expect(ALL_SCOPES).toHaveLength(3);
  });
});

// ── SCOPE_ACCESS_RULES ───────────────────────────────────────────────────

describe("SCOPE_ACCESS_RULES", () => {
  it("has entries for every member of ALL_SCOPES", () => {
    for (const scope of ALL_SCOPES) {
      expect(SCOPE_ACCESS_RULES[scope]).toBeDefined();
      expect(SCOPE_ACCESS_RULES[scope]).toHaveProperty("read");
      expect(SCOPE_ACCESS_RULES[scope]).toHaveProperty("write");
      expect(SCOPE_ACCESS_RULES[scope]).toHaveProperty("bootstrap");
    }
  });

  it("global scope: read=any, write=kernel, bootstrap=true", () => {
    expect(SCOPE_ACCESS_RULES.global).toEqual({ read: "any", write: "kernel", bootstrap: true });
  });

  it("workspace scope: read=owner, write=owner, bootstrap=true", () => {
    expect(SCOPE_ACCESS_RULES.workspace).toEqual({
      read: "owner",
      write: "owner",
      bootstrap: true,
    });
  });

  it("mounted scope: read=any, write=owner, bootstrap=true", () => {
    expect(SCOPE_ACCESS_RULES.mounted).toEqual({ read: "any", write: "owner", bootstrap: true });
  });
});

// ── PER-WORKSPACE scope (own stores) ────────────────────────────────────

describe("buildResolvedWorkspaceMemory with only own stores", () => {
  it("produces workspace-scoped entries with correct type/strategy", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [
        { name: "notes", type: "short_term" },
        { name: "backlog", type: "long_term", strategy: "narrative" },
        { name: "scratch", type: "scratchpad" },
      ],
      mountDeclarations: [],
      kernelWorkspaceId: undefined,
    });

    expect(resolved.own).toHaveLength(3);
    for (const store of resolved.own) {
      expect(store.scope).toBe("workspace");
    }

    const notes = resolved.own.find((c) => c.name === "notes");
    expect(notes?.type).toBe("short_term");
    expect(notes?.strategy).toBeUndefined();

    const backlog = resolved.own.find((c) => c.name === "backlog");
    expect(backlog?.type).toBe("long_term");
    expect(backlog?.strategy).toBe("narrative");

    const scratch = resolved.own.find((c) => c.name === "scratch");
    expect(scratch?.type).toBe("scratchpad");
    expect(scratch?.strategy).toBeUndefined();

    expect(resolved.mounts).toHaveLength(0);
    expect(resolved.globalAccess.canRead).toBe(false);
    expect(resolved.globalAccess.canWrite).toBe(false);
  });
});

// ── MOUNTED scope (source string parsing) ────────────────────────────────

describe("buildResolvedWorkspaceMemory with mount declarations", () => {
  it("parses source strings into {sourceWorkspaceId, sourceStoreKind, sourceStoreName}", () => {
    const decls: MountDeclaration[] = [
      {
        name: "autopilot-backlog",
        source: "thick_endive/narrative/autopilot-backlog",
        mode: "ro",
        scope: "workspace",
      },
      {
        name: "config-store",
        source: "braised_biscuit/narrative/config",
        mode: "rw",
        scope: "agent",
        scopeTarget: "my-agent",
      },
    ];

    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "some_ws",
      ownEntries: [],
      mountDeclarations: decls,
      kernelWorkspaceId: undefined,
    });

    expect(resolved.mounts).toHaveLength(2);

    const m0 = resolved.mounts[0];
    expect(m0?.sourceWorkspaceId).toBe("thick_endive");
    expect(m0?.sourceStoreKind).toBe("narrative");
    expect(m0?.sourceStoreName).toBe("autopilot-backlog");

    const m1 = resolved.mounts[1];
    expect(m1?.sourceWorkspaceId).toBe("braised_biscuit");
    expect(m1?.sourceStoreKind).toBe("narrative");
    expect(m1?.sourceStoreName).toBe("config");
    expect(m1?.scope).toBe("agent");
    expect(m1?.scopeTarget).toBe("my-agent");
  });
});

// ── GLOBAL scope (kernel gate) ───────────────────────────────────────────

describe("buildResolvedWorkspaceMemory with _global mounts", () => {
  it("sets globalAccess.canRead=true when _global mount present", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [
        { name: "orders", source: "_global/narrative/orders", mode: "ro", scope: "workspace" },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.globalAccess.canRead).toBe(true);
  });

  it("sets globalAccess.canWrite=true only when workspaceId matches kernelWorkspaceId", () => {
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

  it("sets globalAccess.canWrite=false for non-kernel workspace even with rw mount", () => {
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
});

// ── MemoryScopeDescriptor union ──────────────────────────────────────────

describe("MemoryScopeDescriptor union", () => {
  it("covers all three scope variants (global with kernelOnly, workspace with ownerId, mounted with source+mode)", () => {
    const globalDesc: MemoryScopeDescriptor = { scope: "global", kernelOnly: true };
    const workspaceDesc: MemoryScopeDescriptor = { scope: "workspace", ownerId: "braised_biscuit" };
    const mountedDesc: MemoryScopeDescriptor = {
      scope: "mounted",
      source: "_global/narrative/orders",
      mode: "ro",
    };

    expect(globalDesc.scope).toBe("global");
    expect(workspaceDesc.scope).toBe("workspace");
    expect(mountedDesc.scope).toBe("mounted");

    function describeScope(desc: MemoryScopeDescriptor): string {
      switch (desc.scope) {
        case "global":
          return `global(kernelOnly=${desc.kernelOnly})`;
        case "workspace":
          return `workspace(owner=${desc.ownerId})`;
        case "mounted":
          return `mounted(source=${desc.source}, mode=${desc.mode})`;
      }
    }

    expect(describeScope(globalDesc)).toBe("global(kernelOnly=true)");
    expect(describeScope(workspaceDesc)).toBe("workspace(owner=braised_biscuit)");
    expect(describeScope(mountedDesc)).toBe("mounted(source=_global/narrative/orders, mode=ro)");
  });
});

// ── Mixed three-scope composition ────────────────────────────────────────

describe("mixed three-scope composition", () => {
  it("workspace with own + global mount + cross-workspace mount produces correct resolved memory", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [
        { name: "notes", type: "short_term" },
        { name: "backlog", type: "long_term", strategy: "narrative" },
      ],
      mountDeclarations: [
        { name: "orders", source: "_global/narrative/orders", mode: "ro", scope: "workspace" },
        {
          name: "reflections",
          source: "thick_endive/narrative/reflections",
          mode: "ro",
          scope: "workspace",
        },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.own).toHaveLength(2);
    expect(resolved.mounts).toHaveLength(2);
    expect(resolved.globalAccess.canRead).toBe(true);
    expect(resolved.globalAccess.canWrite).toBe(false);
    expect(resolved.workspaceId).toBe("braised_biscuit");

    const globalMount = resolved.mounts.find((m) => m.sourceWorkspaceId === "_global");
    expect(globalMount?.sourceStoreName).toBe("orders");

    const crossMount = resolved.mounts.find((m) => m.sourceWorkspaceId === "thick_endive");
    expect(crossMount?.sourceStoreName).toBe("reflections");
  });
});
