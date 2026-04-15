import { describe, expect, it } from "vitest";
import { mountRegistry } from "../mount-registry.ts";

describe("mountRegistry.clear()", () => {
  it("removes all sources and consumers after clear", () => {
    const sourceId = "test-ws/narrative/logs";
    mountRegistry.registerSource(sourceId, () =>
      Promise.resolve({
        append: () => Promise.resolve({ id: "1", text: "", createdAt: "" }),
        read: () => Promise.resolve([]),
        search: () => Promise.resolve([]),
        forget: () => Promise.resolve(),
        render: () => Promise.resolve(""),
      }),
    );
    mountRegistry.addConsumer(sourceId, "consumer-ws");

    expect(mountRegistry.hasSource(sourceId)).toBe(true);
    expect(mountRegistry.getConsumers(sourceId).size).toBe(1);

    mountRegistry.clear();

    expect(mountRegistry.hasSource(sourceId)).toBe(false);
    expect(mountRegistry.getConsumers(sourceId).size).toBe(0);
  });

  it("is safe to call when already empty", () => {
    mountRegistry.clear();
    expect(mountRegistry.hasSource("anything")).toBe(false);
  });
});
