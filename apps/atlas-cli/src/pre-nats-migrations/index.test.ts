/**
 * Tests for the pre-NATS registry runner. Production tests of the
 * relocate-store entry live in `relocate-store.test.ts`. These tests
 * exercise `runPreNatsMigrations` directly with stub registries to verify
 * the order and first-failure-aborts contract.
 */

import type { Logger } from "@atlas/logger";
import { describe, expect, it, vi } from "vitest";
import { listPreNatsEntries, runPreNatsMigrations } from "./index.ts";
import type { PreNatsMigration } from "./types.ts";

const noopLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => noopLogger,
} as unknown as Logger;

function stub(
  id: string,
  status: "noop" | "error" | "migrated",
  ran: { ids: string[] },
): PreNatsMigration {
  return {
    id,
    name: id,
    description: id,
    run: async () => {
      await Promise.resolve();
      ran.ids.push(id);
      if (status === "error") {
        return {
          id,
          status: "error",
          legacy_path: "",
          target_path: "",
          target_source: "default",
          error: { kind: "unknown", message: `${id} failed` },
          duration_ms: 1,
        };
      }
      return {
        id,
        status,
        legacy_path: "",
        target_path: "",
        target_source: "default",
        duration_ms: 0,
      };
    },
  };
}

describe("runPreNatsMigrations", () => {
  it("runs entries in registry order and returns outcomes", async () => {
    const ran = { ids: [] as string[] };
    const result = await runPreNatsMigrations(noopLogger, { dryRun: false }, [
      stub("a", "noop", ran),
      stub("b", "noop", ran),
    ]);
    expect(ran.ids).toEqual(["a", "b"]);
    expect(result.aborted).toBe(false);
    expect(result.outcomes.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("aborts on first error and skips subsequent entries", async () => {
    const ran = { ids: [] as string[] };
    const result = await runPreNatsMigrations(noopLogger, { dryRun: false }, [
      stub("first", "error", ran),
      stub("second", "noop", ran),
    ]);
    expect(ran.ids).toEqual(["first"]);
    expect(result.aborted).toBe(true);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.status).toBe("error");
  });

  it("converts thrown exceptions into synthetic error outcomes", async () => {
    const thrower: PreNatsMigration = {
      id: "throws",
      name: "throws",
      description: "throws",
      run: async () => {
        await Promise.resolve();
        throw new Error("native crash");
      },
    };
    const result = await runPreNatsMigrations(noopLogger, { dryRun: false }, [thrower]);
    expect(result.aborted).toBe(true);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.status).toBe("error");
    expect(result.outcomes[0]?.error?.message).toBe("native crash");
    expect(result.outcomes[0]?.error?.kind).toBe("unknown");
  });
});

describe("listPreNatsEntries", () => {
  it("returns metadata for each registered entry", () => {
    const entries = listPreNatsEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.description).toBe("string");
    }
    // Production registry currently includes relocate-jetstream-store.
    expect(entries.some((e) => e.id === "relocate-jetstream-store")).toBe(true);
  });
});
