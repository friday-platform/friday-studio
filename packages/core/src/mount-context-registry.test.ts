import { afterEach, describe, expect, it } from "vitest";
import {
  clearMountContextRegistry,
  mountContextKey,
  setMountContext,
  takeMountContext,
} from "./mount-context-registry.ts";

describe("mount-context-registry", () => {
  afterEach(() => {
    clearMountContextRegistry();
  });

  it("mountContextKey builds deterministic key from sessionId and agentId", () => {
    expect(mountContextKey("sess-1", "planner")).toBe("sess-1:planner");
  });

  it("set then take returns the stored context and removes it", () => {
    const key = mountContextKey("sess-1", "planner");
    const ctx = { mounts: { backlog: {} } };
    setMountContext(key, ctx as never);

    const result = takeMountContext(key);
    expect(result).toBe(ctx);

    const secondTake = takeMountContext(key);
    expect(secondTake).toBeUndefined();
  });

  it("take on missing key returns undefined", () => {
    expect(takeMountContext("nonexistent")).toBeUndefined();
  });

  it("clearMountContextRegistry removes all entries", () => {
    setMountContext("a", { mounts: {} });
    setMountContext("b", { mounts: {} });
    clearMountContextRegistry();

    expect(takeMountContext("a")).toBeUndefined();
    expect(takeMountContext("b")).toBeUndefined();
  });
});
