import { describe, expect, it } from "vitest";
import type {
  MemoryScope,
  MemoryScopeDescriptor,
  MountDeclaration,
  MountMode,
} from "../memory-scope.ts";
import {
  GLOBAL_MEMORY_BASE_PATH,
  GLOBAL_WORKSPACE_ID,
  resolveMemoryBasePath,
} from "../memory-scope.ts";

describe("MountDeclaration type contracts", () => {
  it("accepts mode='ro' with workspace scope", () => {
    const decl: MountDeclaration = {
      name: "shared-orders",
      source: "_global/narrative/orders",
      mode: "ro",
      scope: "workspace",
    };
    expect(decl.mode).toBe("ro");
    expect(decl.scope).toBe("workspace");
  });

  it("accepts mode='rw' with agent scope and scopeTarget", () => {
    const decl: MountDeclaration = {
      name: "shared-orders",
      source: "ws-123/kv/orders",
      mode: "rw",
      scope: "agent",
      scopeTarget: "my-agent",
    };
    expect(decl.mode).toBe("rw");
    expect(decl.scopeTarget).toBe("my-agent");
  });

  it("accepts optional filter", () => {
    const decl: MountDeclaration = {
      name: "filtered-mount",
      source: "_global/narrative/standing-orders",
      mode: "ro",
      scope: "workspace",
      filter: { status: "active", priority_min: 3 },
    };
    expect(decl.filter?.status).toBe("active");
    expect(decl.filter?.priority_min).toBe(3);
  });
});

describe("MountMode type", () => {
  it("accepts ro and rw", () => {
    const ro: MountMode = "ro";
    const rw: MountMode = "rw";
    expect(ro).toBe("ro");
    expect(rw).toBe("rw");
  });
});

describe("MemoryScope type", () => {
  it("accepts all three scope values", () => {
    const scopes: MemoryScope[] = ["global", "workspace", "mounted"];
    expect(scopes).toHaveLength(3);
  });
});

describe("resolveMemoryBasePath", () => {
  it("returns global path for GLOBAL_WORKSPACE_ID", () => {
    expect(resolveMemoryBasePath(GLOBAL_WORKSPACE_ID)).toBe("memory/_global/");
    expect(resolveMemoryBasePath("_global")).toBe(GLOBAL_MEMORY_BASE_PATH);
  });

  it("returns workspace-scoped path for real workspace IDs", () => {
    expect(resolveMemoryBasePath("braised_biscuit")).toBe("memory/braised_biscuit/");
    expect(resolveMemoryBasePath("thick_endive")).toBe("memory/thick_endive/");
  });
});

describe("MemoryScopeDescriptor discriminated union", () => {
  it("accepts global scope with kernelOnly", () => {
    const desc: MemoryScopeDescriptor = { scope: "global", kernelOnly: true };
    expect(desc.scope).toBe("global");
    if (desc.scope === "global") {
      expect(desc.kernelOnly).toBe(true);
    }
  });

  it("accepts workspace scope with ownerId", () => {
    const desc: MemoryScopeDescriptor = { scope: "workspace", ownerId: "braised_biscuit" };
    expect(desc.scope).toBe("workspace");
    if (desc.scope === "workspace") {
      expect(desc.ownerId).toBe("braised_biscuit");
    }
  });

  it("accepts mounted scope with source and mode", () => {
    const desc: MemoryScopeDescriptor = {
      scope: "mounted",
      source: "_global/narrative/orders",
      mode: "ro",
    };
    expect(desc.scope).toBe("mounted");
    if (desc.scope === "mounted") {
      expect(desc.source).toBe("_global/narrative/orders");
      expect(desc.mode).toBe("ro");
    }
  });

  it("exhaustiveness check via function", () => {
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
    expect(describeScope({ scope: "global", kernelOnly: false })).toBe("global(kernelOnly=false)");
    expect(describeScope({ scope: "workspace", ownerId: "ws1" })).toBe("workspace(owner=ws1)");
    expect(describeScope({ scope: "mounted", source: "a/b/c", mode: "rw" })).toBe(
      "mounted(source=a/b/c, mode=rw)",
    );
  });
});
