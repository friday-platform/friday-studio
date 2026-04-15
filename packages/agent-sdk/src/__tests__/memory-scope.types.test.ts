import { describe, expect, it } from "vitest";
import type {
  MemoryScope,
  MountDeclaration,
  MountMode,
  MountRegistry,
  MountRegistryEntry,
} from "../memory-scope.ts";

describe("MountDeclaration type contracts", () => {
  it("accepts mode='read'", () => {
    const decl: MountDeclaration = {
      alias: "shared-orders",
      sourceWorkspaceId: "_global",
      sourceCorpus: "orders",
      mode: "read",
    };
    expect(decl.mode).toBe("read");
  });

  it("accepts mode='read-write'", () => {
    const decl: MountDeclaration = {
      alias: "shared-orders",
      sourceWorkspaceId: "ws-123",
      sourceCorpus: "orders",
      mode: "read-write",
    };
    expect(decl.mode).toBe("read-write");
  });
});

describe("MountRegistryEntry type contracts", () => {
  it("wraps MountDeclaration with consumer context", () => {
    const mount: MountDeclaration = {
      alias: "shared-orders",
      sourceWorkspaceId: "_global",
      sourceCorpus: "orders",
      mode: "read",
    };
    const entry: MountRegistryEntry = {
      consumerWorkspaceId: "ws-consumer",
      mount,
      resolvedAt: "2026-04-14T00:00:00Z",
    };
    expect(entry.consumerWorkspaceId).toBe("ws-consumer");
    expect(entry.mount.alias).toBe("shared-orders");
    expect(entry.resolvedAt).toBe("2026-04-14T00:00:00Z");
  });
});

describe("MountMode type", () => {
  it("accepts read and read-write", () => {
    const read: MountMode = "read";
    const rw: MountMode = "read-write";
    expect(read).toBe("read");
    expect(rw).toBe("read-write");
  });
});

describe("MemoryScope type", () => {
  it("accepts all three scope values", () => {
    const scopes: MemoryScope[] = ["global", "workspace", "mounted"];
    expect(scopes).toHaveLength(3);
  });
});

describe("MountRegistry interface shape", () => {
  it("has the five required methods", () => {
    const stub: MountRegistry = {
      resolve: () => undefined,
      listByConsumer: () => [],
      listBySource: () => [],
      register: () => Promise.resolve(),
      deregister: () => {},
    };
    expect(typeof stub.resolve).toBe("function");
    expect(typeof stub.listByConsumer).toBe("function");
    expect(typeof stub.listBySource).toBe("function");
    expect(typeof stub.register).toBe("function");
    expect(typeof stub.deregister).toBe("function");
  });

  it("resolve returns MountRegistryEntry or undefined", () => {
    const entry: MountRegistryEntry = {
      consumerWorkspaceId: "ws-1",
      mount: { alias: "a", sourceWorkspaceId: "ws-2", sourceCorpus: "c", mode: "read" },
      resolvedAt: "2026-04-14T00:00:00Z",
    };
    const stub: MountRegistry = {
      resolve: () => entry,
      listByConsumer: () => [entry],
      listBySource: () => [entry],
      register: () => Promise.resolve(),
      deregister: () => {},
    };
    expect(stub.resolve("ws-1", "a")).toEqual(entry);
  });
});
