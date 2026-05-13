import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cycle, push, reset, restoreDraft, saveDraft } from "./prompt-history.ts";

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

describe("prompt-history", () => {
  let originalStorage: Storage;

  beforeEach(() => {
    originalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: createStorageStub(),
      writable: true,
      configurable: true,
    });
    reset();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalStorage,
      writable: true,
      configurable: true,
    });
  });

  describe("push", () => {
    it("stores a prompt in localStorage", () => {
      push("agent-1", "hello world");
      const raw = localStorage.getItem("prompt-history-agent-1");
      expect(raw).not.toBeNull();
      const entries = JSON.parse(raw!) as string[];
      expect(entries).toEqual(["hello world"]);
    });

    it("appends multiple prompts in order", () => {
      push("agent-1", "first");
      push("agent-1", "second");
      push("agent-1", "third");
      const entries = JSON.parse(localStorage.getItem("prompt-history-agent-1")!) as string[];
      expect(entries).toEqual(["first", "second", "third"]);
    });

    it("deduplicates consecutive identical prompts", () => {
      push("agent-1", "same");
      push("agent-1", "same");
      push("agent-1", "same");
      const entries = JSON.parse(localStorage.getItem("prompt-history-agent-1")!) as string[];
      expect(entries).toEqual(["same"]);
    });

    it("allows non-consecutive duplicates", () => {
      push("agent-1", "a");
      push("agent-1", "b");
      push("agent-1", "a");
      const entries = JSON.parse(localStorage.getItem("prompt-history-agent-1")!) as string[];
      expect(entries).toEqual(["a", "b", "a"]);
    });

    it("caps history at 50 entries, dropping oldest", () => {
      for (let i = 0; i < 55; i++) {
        push("agent-1", `prompt-${i}`);
      }
      const entries = JSON.parse(localStorage.getItem("prompt-history-agent-1")!) as string[];
      expect(entries).toHaveLength(50);
      expect(entries[0]).toBe("prompt-5");
      expect(entries[49]).toBe("prompt-54");
    });

    it("isolates history per agent", () => {
      push("agent-1", "hello");
      push("agent-2", "world");
      const entries1 = JSON.parse(localStorage.getItem("prompt-history-agent-1")!) as string[];
      const entries2 = JSON.parse(localStorage.getItem("prompt-history-agent-2")!) as string[];
      expect(entries1).toEqual(["hello"]);
      expect(entries2).toEqual(["world"]);
    });
  });

  describe("cycle", () => {
    it("returns null when history is empty", () => {
      expect(cycle("agent-1", "prev")).toBeNull();
      expect(cycle("agent-1", "next")).toBeNull();
    });

    it("returns the most recent entry on first prev", () => {
      push("agent-1", "first");
      push("agent-1", "second");
      push("agent-1", "third");
      expect(cycle("agent-1", "prev")).toBe("third");
    });

    it("cycles backward through history", () => {
      push("agent-1", "first");
      push("agent-1", "second");
      push("agent-1", "third");
      expect(cycle("agent-1", "prev")).toBe("third");
      expect(cycle("agent-1", "prev")).toBe("second");
      expect(cycle("agent-1", "prev")).toBe("first");
    });

    it("returns null when cycling past the oldest entry", () => {
      push("agent-1", "only");
      expect(cycle("agent-1", "prev")).toBe("only");
      expect(cycle("agent-1", "prev")).toBeNull();
    });

    it("cycles forward after cycling backward", () => {
      push("agent-1", "first");
      push("agent-1", "second");
      push("agent-1", "third");
      cycle("agent-1", "prev"); // third
      cycle("agent-1", "prev"); // second
      expect(cycle("agent-1", "next")).toBe("third");
    });

    it("returns null when cycling forward past the newest entry", () => {
      push("agent-1", "first");
      push("agent-1", "second");
      cycle("agent-1", "prev"); // second
      expect(cycle("agent-1", "next")).toBeNull();
    });

    it("returns null on next when not in history mode", () => {
      push("agent-1", "first");
      expect(cycle("agent-1", "next")).toBeNull();
    });
  });

  describe("reset", () => {
    it("clears the cycle index so next prev starts from the end", () => {
      push("agent-1", "first");
      push("agent-1", "second");
      cycle("agent-1", "prev"); // second
      cycle("agent-1", "prev"); // first
      reset();
      expect(cycle("agent-1", "prev")).toBe("second");
    });
  });

  describe("saveDraft / restoreDraft", () => {
    it("saves and restores draft text", () => {
      saveDraft("agent-1", "work in progress");
      expect(restoreDraft("agent-1")).toBe("work in progress");
    });

    it("returns null when no draft exists", () => {
      expect(restoreDraft("agent-1")).toBeNull();
    });

    it("overwrites previous draft", () => {
      saveDraft("agent-1", "first draft");
      saveDraft("agent-1", "second draft");
      expect(restoreDraft("agent-1")).toBe("second draft");
    });

    it("isolates drafts per agent", () => {
      saveDraft("agent-1", "draft a");
      saveDraft("agent-2", "draft b");
      expect(restoreDraft("agent-1")).toBe("draft a");
      expect(restoreDraft("agent-2")).toBe("draft b");
    });

    it("saves empty string as valid draft", () => {
      saveDraft("agent-1", "");
      expect(restoreDraft("agent-1")).toBe("");
    });
  });
});
