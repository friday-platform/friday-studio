import { describe, expect, it } from "vitest";
import {
  buildTimezoneGroups,
  formatTimezone,
  formatTimezoneCity,
  formatUtcOffset,
  getTimezoneOffset,
  TIMEZONE_GROUPS,
} from "./timezone.ts";

describe("formatTimezone", () => {
  it("replaces underscores with spaces", () => {
    expect(formatTimezone("New_York")).toBe("New York");
  });

  it("handles multiple underscores", () => {
    expect(formatTimezone("Argentina/Buenos_Aires")).toBe("Argentina/Buenos Aires");
  });

  it("returns string unchanged when no underscores", () => {
    expect(formatTimezone("London")).toBe("London");
  });
});

describe("formatTimezoneCity", () => {
  it("extracts city from Region/City format", () => {
    expect(formatTimezoneCity("America/New_York")).toBe("New York");
  });

  it("extracts city from Region/Sub/City format", () => {
    expect(formatTimezoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
  });

  it("returns input when no slash", () => {
    expect(formatTimezoneCity("UTC")).toBe("UTC");
  });
});

describe("formatUtcOffset", () => {
  it("returns a GMT offset string for a valid timezone", () => {
    const result = formatUtcOffset("UTC");
    expect(result).toMatch(/GMT/);
  });

  it("returns empty string for invalid timezone", () => {
    expect(formatUtcOffset("Invalid/Zone")).toBe("");
  });
});

describe("getTimezoneOffset", () => {
  it("returns a finite number for a valid timezone", () => {
    const offset = getTimezoneOffset("America/New_York");
    expect(Number.isFinite(offset)).toBe(true);
  });

  it("returns 0 for UTC", () => {
    expect(getTimezoneOffset("UTC")).toBe(0);
  });

  it("returns Infinity for invalid timezone", () => {
    expect(getTimezoneOffset("Invalid/Zone")).toBe(Infinity);
  });
});

describe("buildTimezoneGroups", () => {
  it("returns Suggested as first group", () => {
    const groups = buildTimezoneGroups("America/New_York");
    expect(groups[0]?.label).toBe("Suggested");
  });

  it("suggested group has at most 6 zones", () => {
    const groups = buildTimezoneGroups("America/New_York");
    const suggested = groups[0];
    expect(suggested?.zones.length).toBeLessThanOrEqual(6);
    expect(suggested?.zones.length).toBeGreaterThan(0);
  });

  it("includes all base groups after Suggested", () => {
    const groups = buildTimezoneGroups("UTC");
    const labels = groups.map((g) => g.label);
    expect(labels).toContain("Americas");
    expect(labels).toContain("Europe");
    expect(labels).toContain("Asia");
    expect(labels).toContain("Pacific");
    expect(labels).toContain("Africa");
  });

  it("sorts zones within each group by offset", () => {
    const groups = buildTimezoneGroups("UTC");
    for (const group of groups) {
      const offsets = group.zones.map(getTimezoneOffset);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
      }
    }
  });
});

describe("TIMEZONE_GROUPS", () => {
  it("contains only valid IANA timezones", () => {
    for (const group of TIMEZONE_GROUPS) {
      for (const tz of group.zones) {
        expect(() => Intl.DateTimeFormat(undefined, { timeZone: tz })).not.toThrow();
      }
    }
  });
});
