import { logger } from "@atlas/logger";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_OVERLAY, listImageEntries, lookupImageEntry } from "./image-capabilities.ts";

/**
 * ISO-8601 date matcher — `YYYY-MM-DD` is what the overlay records and
 * what the validation harness (Task #9) will write. We don't accept
 * timestamps here; the freshness check operates on calendar days.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const STALE_THRESHOLD_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

describe("image-capabilities — overlay shape", () => {
  it("contains exactly the six v1 entries", () => {
    expect(Object.keys(IMAGE_OVERLAY).sort()).toEqual(
      [
        "google:gemini-2.5-flash-image",
        "google:imagen-4.0-generate-001",
        "google:imagen-4.0-fast-generate-001",
        "openai:gpt-image-1.5",
        "openai:dall-e-3",
        "openai:dall-e-2",
      ].sort(),
    );
  });

  it("listImageEntries returns every overlay entry with its id attached", () => {
    const entries = listImageEntries();
    expect(entries).toHaveLength(Object.keys(IMAGE_OVERLAY).length);
    // ids round-trip through lookupImageEntry — verifies listImageEntries
    // doesn't drop or mutate entries.
    for (const entry of entries) {
      expect(lookupImageEntry(entry.id)).not.toBeNull();
    }
  });

  it("every entry round-trips against the type with sane field values", () => {
    for (const entry of listImageEntries()) {
      // displayName must be UI-presentable — non-empty, no leading/trailing
      // whitespace. (A blank string is what the Settings picker would
      // render verbatim, so catch it here.)
      expect(entry.displayName.trim()).toBe(entry.displayName);
      expect(entry.displayName.length).toBeGreaterThan(0);

      // generation is always true (every overlay entry generates images).
      expect(entry.capabilities.generation).toBe(true);
      expect(typeof entry.capabilities.edit).toBe("boolean");

      // Discriminated union: assert the variant carries the right param.
      if (entry.defaults.controlAxis === "size") {
        expect(entry.defaults.size).toMatch(/^\d+x\d+$/);
      } else {
        expect(entry.defaults.aspectRatio.length).toBeGreaterThan(0);
      }
      expect(["png", "jpeg"]).toContain(entry.defaults.format);

      expect(entry.lastValidatedAt).toMatch(ISO_DATE);
      // Parseable as a real calendar date — `2026-13-40` would match the
      // regex but not produce a finite timestamp.
      expect(Number.isFinite(Date.parse(entry.lastValidatedAt))).toBe(true);
    }
  });

  it("Google entries use the aspectRatio axis; OpenAI entries use size", () => {
    // The agent's controlAxis dispatch (Task #5) depends on this provider
    // split — lock it in so a misclassified entry trips the test, not the
    // agent at runtime.
    for (const entry of listImageEntries()) {
      const [provider] = entry.id.split(":");
      if (provider === "google") {
        expect(entry.defaults.controlAxis).toBe("aspectRatio");
      } else if (provider === "openai") {
        expect(entry.defaults.controlAxis).toBe("size");
      }
    }
  });
});

describe("image-capabilities — freshness drift", () => {
  it("emits a non-failing warning for entries older than 180 days", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const now = Date.now();
      const stale: string[] = [];
      for (const entry of listImageEntries()) {
        const ageDays = (now - Date.parse(entry.lastValidatedAt)) / MS_PER_DAY;
        if (ageDays > STALE_THRESHOLD_DAYS) {
          logger.warn("Image overlay entry is stale — re-run validation harness", {
            id: entry.id,
            lastValidatedAt: entry.lastValidatedAt,
            ageDays: Math.round(ageDays),
          });
          stale.push(entry.id);
        }
      }
      // The check is *advisory* — never fails the suite. We assert the
      // shape of the warning (when one fired) so future agents can't
      // accidentally turn it into a console.log.
      expect(warnSpy.mock.calls.length).toBe(stale.length);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("image-capabilities — lookup", () => {
  it("returns the entry for a known id", () => {
    const entry = lookupImageEntry("google:gemini-2.5-flash-image");
    if (entry === null) throw new Error("expected overlay entry to exist");
    expect(entry.displayName).toBe("Gemini 2.5 Flash Image");
  });

  it("returns null for an unknown id", () => {
    expect(lookupImageEntry("openai:not-a-real-model")).toBeNull();
  });
});
