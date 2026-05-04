/**
 * Three-Scope Memory Model — Composite Integration Tests
 *
 * Validates the full three-scope composition in one place:
 *   1. GLOBAL  — synthetic workspace id "_global", write-gated to kernel
 *   2. PER-WORKSPACE — owned by exactly one workspace, scope="workspace"
 *   3. MOUNTED — runtime alias resolved from workspace.yml memory.mounts[]
 *
 * Individual scope mechanics are tested in isolation in:
 *   - memory-scope.constants.test.ts  (isGlobalScope, GLOBAL_WORKSPACE_ID)
 *   - resolved-memory.test.ts         (schema validation, kernel gate)
 *   - config-schema.memory-*.test.ts  (Zod config schemas)
 *
 * This file validates the composite invariants — scenarios where all three
 * scopes are active simultaneously and the invariants from the task brief hold.
 */
import { describe, expect, it } from "vitest";

import {
  GLOBAL_WORKSPACE_ID,
  isGlobalScope,
  type MemoryScope,
  type MemoryScopeDescriptor,
  type MountDeclaration,
  resolveMemoryBasePath,
} from "../memory-scope.ts";
import {
  buildResolvedWorkspaceMemory,
  type ResolvedMount,
  type ResolvedOwnStore,
  type ResolvedWorkspaceMemory,
} from "../resolved-memory.ts";

// ── GLOBAL scope invariants ───────────────────────────────────────────────

describe("GLOBAL scope invariants", () => {
  it("isGlobalScope returns true only for GLOBAL_WORKSPACE_ID ('_global')", () => {
    expect(isGlobalScope(GLOBAL_WORKSPACE_ID)).toBe(true);
    expect(isGlobalScope("_global")).toBe(true);

    expect(isGlobalScope("braised_biscuit")).toBe(false);
    expect(isGlobalScope("global")).toBe(false);
    expect(isGlobalScope("_Global")).toBe(false);
    expect(isGlobalScope("")).toBe(false);
  });

  it("resolveMemoryBasePath returns 'memory/_global/' for global scope", () => {
    expect(resolveMemoryBasePath(GLOBAL_WORKSPACE_ID)).toBe("memory/_global/");
    expect(resolveMemoryBasePath("_global")).toBe("memory/_global/");
  });

  it("resolveMemoryBasePath returns 'memory/{wsId}/' for workspace scope", () => {
    expect(resolveMemoryBasePath("braised_biscuit")).toBe("memory/braised_biscuit/");
    expect(resolveMemoryBasePath("thick_endive")).toBe("memory/thick_endive/");
    expect(resolveMemoryBasePath("some-ws")).toBe("memory/some-ws/");
  });

  it("GLOBAL mount with _global source sets canRead=true, canWrite=false for non-kernel workspace", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [
        { name: "orders", source: "_global/narrative/orders", mode: "ro", scope: "workspace" },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.globalAccess.canRead).toBe(true);
    expect(resolved.globalAccess.canWrite).toBe(false);
  });

  it("kernel workspace with _global/rw mount gets canWrite=true", () => {
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

  it("non-kernel workspace with _global/rw mount still gets canWrite=false", () => {
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

// ── PER-WORKSPACE scope invariants ────────────────────────────────────────

describe("PER-WORKSPACE scope invariants", () => {
  it("own entries always get scope='workspace' tag", () => {
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

    for (const store of resolved.own) {
      expect(store.scope).toBe("workspace");
    }
  });

  it("own stores retain name and type from input", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [{ name: "reflections", type: "long_term", strategy: "narrative" }],
      mountDeclarations: [],
      kernelWorkspaceId: undefined,
    });

    const store = resolved.own[0];
    expect(store?.name).toBe("reflections");
    expect(store?.type).toBe("long_term");
    expect(store?.strategy).toBe("narrative");
  });

  it("workspaceId is preserved on the resolved memory object", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [],
      kernelWorkspaceId: undefined,
    });

    expect(resolved.workspaceId).toBe("braised_biscuit");
  });
});

// ── MOUNTED scope invariants ──────────────────────────────────────────────

describe("MOUNTED scope invariants", () => {
  it("carries parsed sourceWorkspaceId, sourceStoreKind, sourceStoreName from source string", () => {
    const decl: MountDeclaration = {
      name: "autopilot-backlog",
      source: "thick_endive/narrative/autopilot-backlog",
      mode: "ro",
      scope: "workspace",
    };

    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [decl],
      kernelWorkspaceId: undefined,
    });

    const mount = resolved.mounts[0];
    expect(mount?.sourceWorkspaceId).toBe("thick_endive");
    expect(mount?.sourceStoreKind).toBe("narrative");
    expect(mount?.sourceStoreName).toBe("autopilot-backlog");
  });

  it("parses _global as the sourceWorkspaceId for global mounts", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [
        { name: "orders", source: "_global/narrative/orders", mode: "ro", scope: "workspace" },
      ],
      kernelWorkspaceId: undefined,
    });

    const mount = resolved.mounts[0];
    expect(mount?.sourceWorkspaceId).toBe("_global");
    expect(mount?.sourceStoreKind).toBe("narrative");
    expect(mount?.sourceStoreName).toBe("orders");
  });

  it("preserves mode field from MountDeclaration", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [
        { name: "ro-mount", source: "ws1/narrative/corpus", mode: "ro", scope: "workspace" },
        { name: "rw-mount", source: "ws2/narrative/config", mode: "rw", scope: "workspace" },
      ],
      kernelWorkspaceId: undefined,
    });

    expect(resolved.mounts[0]?.mode).toBe("ro");
    expect(resolved.mounts[1]?.mode).toBe("rw");
  });
});

// ── Mixed three-scope scenario ─────────────────────────────────────────────

describe("mixed three-scope composition", () => {
  it("workspace with own stores + _global mount + cross-workspace mount produces correct ResolvedWorkspaceMemory", () => {
    const ownEntries = [
      { name: "notes", type: "short_term" },
      { name: "backlog", type: "long_term", strategy: "narrative" },
    ];

    const mountDeclarations: MountDeclaration[] = [
      // GLOBAL scope mount
      { name: "orders", source: "_global/narrative/orders", mode: "ro", scope: "workspace" },
      // MOUNTED cross-workspace
      {
        name: "reflections",
        source: "thick_endive/narrative/reflections",
        mode: "ro",
        scope: "workspace",
      },
    ];

    const resolved: ResolvedWorkspaceMemory = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries,
      mountDeclarations,
      kernelWorkspaceId: "thick_endive",
    });

    // PER-WORKSPACE scope
    expect(resolved.own).toHaveLength(2);
    for (const own of resolved.own) {
      expect(own.scope).toBe("workspace");
    }

    // MOUNTED scope — two mounts total
    expect(resolved.mounts).toHaveLength(2);

    const globalMount = resolved.mounts.find((m) => m.sourceWorkspaceId === "_global");
    expect(globalMount).toBeDefined();
    expect(globalMount?.sourceStoreName).toBe("orders");
    expect(globalMount?.mode).toBe("ro");

    const crossMount = resolved.mounts.find((m) => m.sourceWorkspaceId === "thick_endive");
    expect(crossMount).toBeDefined();
    expect(crossMount?.sourceStoreName).toBe("reflections");
    expect(crossMount?.mode).toBe("ro");

    // GLOBAL scope — read allowed, write denied (not kernel)
    expect(resolved.globalAccess.canRead).toBe(true);
    expect(resolved.globalAccess.canWrite).toBe(false);

    // workspaceId carried through
    expect(resolved.workspaceId).toBe("braised_biscuit");
  });

  it("kernel workspace has all three scopes with canWrite=true", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "thick_endive",
      ownEntries: [
        { name: "autopilot-backlog", type: "long_term", strategy: "narrative" },
        { name: "reflections", type: "long_term", strategy: "narrative" },
        { name: "improvements", type: "long_term", strategy: "narrative" },
      ],
      mountDeclarations: [
        {
          name: "global-orders",
          source: "_global/narrative/orders",
          mode: "rw",
          scope: "workspace",
        },
        {
          name: "biscuit-notes",
          source: "braised_biscuit/narrative/notes",
          mode: "ro",
          scope: "workspace",
        },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    // PER-WORKSPACE: kernel's own stores
    expect(resolved.own).toHaveLength(3);

    // MOUNTED: both mounts present
    expect(resolved.mounts).toHaveLength(2);

    // GLOBAL: kernel gets rw access
    expect(resolved.globalAccess.canRead).toBe(true);
    expect(resolved.globalAccess.canWrite).toBe(true);
  });

  it("workspace with no global mount has canRead=false and canWrite=false", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "some_ws",
      ownEntries: [{ name: "notes", type: "short_term" }],
      mountDeclarations: [
        { name: "peer-mount", source: "other_ws/narrative/data", mode: "ro", scope: "workspace" },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.globalAccess.canRead).toBe(false);
    expect(resolved.globalAccess.canWrite).toBe(false);
  });
});

// ── MemoryScopeDescriptor discriminated union exhaustiveness ──────────────

describe("MemoryScopeDescriptor discriminated union", () => {
  it("covers all three variants: global, workspace, mounted", () => {
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
  });

  it("global descriptor carries kernelOnly flag", () => {
    const desc: MemoryScopeDescriptor = { scope: "global", kernelOnly: false };
    expect(desc.scope).toBe("global");
    if (desc.scope === "global") {
      expect(typeof desc.kernelOnly).toBe("boolean");
    }
  });

  it("workspace descriptor carries ownerId", () => {
    const desc: MemoryScopeDescriptor = { scope: "workspace", ownerId: "thick_endive" };
    if (desc.scope === "workspace") {
      expect(desc.ownerId).toBe("thick_endive");
    }
  });

  it("mounted descriptor carries source and mode", () => {
    const desc: MemoryScopeDescriptor = {
      scope: "mounted",
      source: "thick_endive/narrative/reflections",
      mode: "rw",
    };
    if (desc.scope === "mounted") {
      expect(desc.source).toBe("thick_endive/narrative/reflections");
      expect(desc.mode).toBe("rw");
    }
  });

  it("exhaustive switch over all three scope variants compiles and runs", () => {
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

    expect(describeScope({ scope: "global", kernelOnly: true })).toBe("global(kernelOnly=true)");
    expect(describeScope({ scope: "workspace", ownerId: "ws1" })).toBe("workspace(owner=ws1)");
    expect(
      describeScope({ scope: "mounted", source: "_global/narrative/orders", mode: "ro" }),
    ).toBe("mounted(source=_global/narrative/orders, mode=ro)");
  });
});

// ── MemoryScope type ───────────────────────────────────────────────────────

describe("MemoryScope type", () => {
  it("covers exactly global, workspace, and mounted", () => {
    const scopes: MemoryScope[] = ["global", "workspace", "mounted"];
    expect(scopes).toHaveLength(3);
  });
});

// ── Type compatibility: ResolvedOwnStore and ResolvedMount ───────────────

describe("type compatibility", () => {
  it("ResolvedOwnStore is structurally correct with scope='workspace'", () => {
    const own: ResolvedOwnStore = {
      name: "autopilot-backlog",
      type: "long_term",
      strategy: "narrative",
      scope: "workspace",
    };
    expect(own.scope).toBe("workspace");
  });

  it("ResolvedMount has all parsed source fields from MountDeclaration", () => {
    const decl: MountDeclaration = {
      name: "reflections",
      source: "thick_endive/narrative/reflections",
      mode: "ro",
      scope: "workspace",
    };
    const mount: ResolvedMount = {
      ...decl,
      sourceWorkspaceId: "thick_endive",
      sourceStoreKind: "narrative",
      sourceStoreName: "reflections",
    };
    expect(mount.name).toBe(decl.name);
    expect(mount.source).toBe(decl.source);
    expect(mount.mode).toBe(decl.mode);
    expect(mount.sourceWorkspaceId).toBe("thick_endive");
    expect(mount.sourceStoreKind).toBe("narrative");
    expect(mount.sourceStoreName).toBe("reflections");
  });
});
