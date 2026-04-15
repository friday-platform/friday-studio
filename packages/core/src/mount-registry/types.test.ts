import { describe, expect, it } from "vitest";
import { buildSourceId, MountConsumerSchema, MountSourceSchema } from "./types.ts";

describe("MountSourceSchema", () => {
  const validSource = {
    id: "ws-1/narrative/logs",
    workspaceId: "ws-1",
    kind: "narrative",
    name: "logs",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAccessedAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a valid MountSource", () => {
    const result = MountSourceSchema.safeParse(validSource);
    expect(result.success).toBe(true);
  });

  it("accepts all four valid kind values", () => {
    for (const kind of ["narrative", "retrieval", "dedup", "kv"]) {
      const result = MountSourceSchema.safeParse({ ...validSource, id: `ws-1/${kind}/logs`, kind });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid kind values", () => {
    const result = MountSourceSchema.safeParse({ ...validSource, kind: "vector" });
    expect(result.success).toBe(false);
  });

  it("rejects non-ISO-8601 datetime strings", () => {
    expect(MountSourceSchema.safeParse({ ...validSource, createdAt: "not-a-date" }).success).toBe(
      false,
    );
    expect(MountSourceSchema.safeParse({ ...validSource, lastAccessedAt: "bad" }).success).toBe(
      false,
    );
  });

  it("rejects missing required fields", () => {
    expect(MountSourceSchema.safeParse({ id: "x" }).success).toBe(false);
    expect(MountSourceSchema.safeParse({}).success).toBe(false);
  });

  it("strips unknown keys", () => {
    const result = MountSourceSchema.safeParse({ ...validSource, extra: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("extra" in result.data).toBe(false);
    }
  });
});

describe("MountConsumerSchema", () => {
  const validConsumer = {
    consumerId: "ws-2",
    sourceId: "ws-1/narrative/logs",
    addedAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a valid MountConsumer", () => {
    const result = MountConsumerSchema.safeParse(validConsumer);
    expect(result.success).toBe(true);
  });

  it("rejects missing consumerId", () => {
    const { consumerId: _, ...rest } = validConsumer;
    expect(MountConsumerSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing sourceId", () => {
    const { sourceId: _, ...rest } = validConsumer;
    expect(MountConsumerSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing addedAt", () => {
    const { addedAt: _, ...rest } = validConsumer;
    expect(MountConsumerSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects non-datetime addedAt", () => {
    expect(MountConsumerSchema.safeParse({ ...validConsumer, addedAt: "not-a-date" }).success).toBe(
      false,
    );
  });
});

describe("buildSourceId", () => {
  it("produces workspaceId/kind/name format", () => {
    expect(buildSourceId("ws-1", "kv", "settings")).toBe("ws-1/kv/settings");
  });

  it("handles all four corpus kinds", () => {
    expect(buildSourceId("ws", "narrative", "n")).toBe("ws/narrative/n");
    expect(buildSourceId("ws", "retrieval", "r")).toBe("ws/retrieval/r");
    expect(buildSourceId("ws", "dedup", "d")).toBe("ws/dedup/d");
    expect(buildSourceId("ws", "kv", "k")).toBe("ws/kv/k");
  });
});
