import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSectionState, sectionStorageKey, writeSectionState } from "./collapsible-state.ts";

/** Minimal localStorage stub for testing. */
function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

describe("collapsible-state", () => {
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

  describe("sectionStorageKey", () => {
    it("formats key as cockpit-section-{workspaceId}-{sectionKey}", () => {
      expect(sectionStorageKey("ws-123", "data-contracts")).toBe(
        "cockpit-section-ws-123-data-contracts",
      );
    });
  });

  describe("readSectionState", () => {
    it("returns defaultExpanded when no entry exists", () => {
      expect(readSectionState("ws-1", "signals", true)).toBe(true);
      expect(readSectionState("ws-1", "signals", false)).toBe(false);
    });

    it("reads persisted true value", () => {
      localStorage.setItem("cockpit-section-ws-1-signals", "true");
      expect(readSectionState("ws-1", "signals", false)).toBe(true);
    });

    it("reads persisted false value", () => {
      localStorage.setItem("cockpit-section-ws-1-signals", "false");
      expect(readSectionState("ws-1", "signals", true)).toBe(false);
    });

    it("isolates state per workspace", () => {
      writeSectionState("ws-a", "contracts", true);
      writeSectionState("ws-b", "contracts", false);
      expect(readSectionState("ws-a", "contracts", true)).toBe(true);
      expect(readSectionState("ws-b", "contracts", true)).toBe(false);
    });
  });

  describe("writeSectionState", () => {
    it("persists expanded state to localStorage", () => {
      writeSectionState("ws-1", "integrations", false);
      expect(localStorage.getItem("cockpit-section-ws-1-integrations")).toBe("false");
    });

    it("overwrites previous value", () => {
      writeSectionState("ws-1", "integrations", true);
      writeSectionState("ws-1", "integrations", false);
      expect(localStorage.getItem("cockpit-section-ws-1-integrations")).toBe("false");
    });
  });
});
