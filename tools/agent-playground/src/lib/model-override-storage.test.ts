import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getModelOverride, setModelOverride } from "./model-override-storage.ts";

/** Minimal localStorage stub for testing. */
function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

describe("model-override-storage", () => {
  let originalStorage: Storage;

  beforeEach(() => {
    originalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: createStorageStub(),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalStorage,
      writable: true,
      configurable: true,
    });
  });

  it("returns null when no override is set", () => {
    expect(getModelOverride("ws-1")).toBeNull();
  });

  it("round-trips an override spec", () => {
    setModelOverride("ws-1", "anthropic:claude-haiku-4-5");
    expect(getModelOverride("ws-1")).toBe("anthropic:claude-haiku-4-5");
  });

  it("writes under the model-override-${workspaceId} key", () => {
    setModelOverride("ws-1", "anthropic:claude-haiku-4-5");
    expect(localStorage.getItem("model-override-ws-1")).toBe("anthropic:claude-haiku-4-5");
  });

  it("isolates overrides per workspace", () => {
    setModelOverride("ws-1", "anthropic:claude-haiku-4-5");
    setModelOverride("ws-2", "openai:gpt-4");
    expect(getModelOverride("ws-1")).toBe("anthropic:claude-haiku-4-5");
    expect(getModelOverride("ws-2")).toBe("openai:gpt-4");
  });

  it("removes the key when set to null (not stored as string 'null')", () => {
    setModelOverride("ws-1", "anthropic:claude-haiku-4-5");
    setModelOverride("ws-1", null);
    expect(getModelOverride("ws-1")).toBeNull();
    expect(localStorage.getItem("model-override-ws-1")).toBeNull();
  });

  it("overwrites a previous override", () => {
    setModelOverride("ws-1", "anthropic:claude-haiku-4-5");
    setModelOverride("ws-1", "openai:gpt-4");
    expect(getModelOverride("ws-1")).toBe("openai:gpt-4");
  });
});
