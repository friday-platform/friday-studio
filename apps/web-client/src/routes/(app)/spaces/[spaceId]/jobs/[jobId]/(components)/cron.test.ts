import { describe, expect, it } from "vitest";
import { buildCron, normalizeInterval, normalizeTime, parseCron } from "./cron.ts";
import type { ScheduleState } from "./cron.ts";

const DEFAULTS = { mode: "schedule" as const, timezone: "UTC" };

describe("parseCron", () => {
  it("hourly", () => {
    expect(parseCron("0 * * * *")).toEqual({
      ...DEFAULTS,
      interval: "hourly",
      days: [],
      time: "",
      period: "AM",
    });
  });

  it("daily AM", () => {
    expect(parseCron("0 9 * * *")).toEqual({
      ...DEFAULTS,
      interval: "daily",
      days: [],
      time: "9:00",
      period: "AM",
    });
  });

  it("daily PM", () => {
    expect(parseCron("30 14 * * *")).toEqual({
      ...DEFAULTS,
      interval: "daily",
      days: [],
      time: "2:30",
      period: "PM",
    });
  });

  it("daily noon", () => {
    expect(parseCron("0 12 * * *")).toEqual({
      ...DEFAULTS,
      interval: "daily",
      days: [],
      time: "12:00",
      period: "PM",
    });
  });

  it("weekly single day AM", () => {
    expect(parseCron("0 9 * * 1")).toEqual({
      ...DEFAULTS,
      interval: "weekly",
      days: ["Monday"],
      time: "9:00",
      period: "AM",
    });
  });

  it("weekly single day PM", () => {
    expect(parseCron("0 17 * * 5")).toEqual({
      ...DEFAULTS,
      interval: "weekly",
      days: ["Friday"],
      time: "5:00",
      period: "PM",
    });
  });

  it("weekly multiple days AM", () => {
    expect(parseCron("0 9 * * 1,5")).toEqual({
      ...DEFAULTS,
      interval: "weekly",
      days: ["Monday", "Friday"],
      time: "9:00",
      period: "AM",
    });
  });

  it("weekly multiple days PM", () => {
    expect(parseCron("0 20 * * 1,3")).toEqual({
      ...DEFAULTS,
      interval: "weekly",
      days: ["Monday", "Wednesday"],
      time: "8:00",
      period: "PM",
    });
  });

  it("interval every 3 hours", () => {
    expect(parseCron("0 */3 * * *")).toEqual({
      ...DEFAULTS,
      interval: "interval",
      days: [],
      time: "3",
      period: "Hours",
    });
  });

  it("interval every 6 hours", () => {
    expect(parseCron("0 */6 * * *")).toEqual({
      ...DEFAULTS,
      interval: "interval",
      days: [],
      time: "6",
      period: "Hours",
    });
  });

  it("midnight (12:00 AM = hour 0)", () => {
    expect(parseCron("0 0 * * *")).toEqual({
      ...DEFAULTS,
      interval: "daily",
      days: [],
      time: "12:00",
      period: "AM",
    });
  });

  it("1 AM", () => {
    expect(parseCron("0 1 * * *")).toEqual({
      ...DEFAULTS,
      interval: "daily",
      days: [],
      time: "1:00",
      period: "AM",
    });
  });

  it("11 AM", () => {
    expect(parseCron("0 11 * * *")).toEqual({
      ...DEFAULTS,
      interval: "daily",
      days: [],
      time: "11:00",
      period: "AM",
    });
  });

  it("1 PM (hour 13)", () => {
    expect(parseCron("0 13 * * *")).toEqual({
      ...DEFAULTS,
      interval: "daily",
      days: [],
      time: "1:00",
      period: "PM",
    });
  });

  it("11 PM (hour 23)", () => {
    expect(parseCron("0 23 * * *")).toEqual({
      ...DEFAULTS,
      interval: "daily",
      days: [],
      time: "11:00",
      period: "PM",
    });
  });
});

describe("buildCron", () => {
  it("hourly", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "hourly",
        days: [],
        time: "",
        period: "AM",
        timezone: "UTC",
      }),
    ).toBe("0 * * * *");
  });

  it("daily AM", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "daily",
        days: [],
        time: "9:00",
        period: "AM",
        timezone: "UTC",
      }),
    ).toBe("0 9 * * *");
  });

  it("daily PM", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "daily",
        days: [],
        time: "2:30",
        period: "PM",
        timezone: "UTC",
      }),
    ).toBe("30 14 * * *");
  });

  it("daily noon", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "daily",
        days: [],
        time: "12:00",
        period: "PM",
        timezone: "UTC",
      }),
    ).toBe("0 12 * * *");
  });

  it("daily midnight", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "daily",
        days: [],
        time: "12:00",
        period: "AM",
        timezone: "UTC",
      }),
    ).toBe("0 0 * * *");
  });

  it("weekly single day AM", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "weekly",
        days: ["Monday"],
        time: "9:00",
        period: "AM",
        timezone: "UTC",
      }),
    ).toBe("0 9 * * 1");
  });

  it("weekly single day PM", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "weekly",
        days: ["Friday"],
        time: "5:00",
        period: "PM",
        timezone: "UTC",
      }),
    ).toBe("0 17 * * 5");
  });

  it("weekly multiple days AM", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "weekly",
        days: ["Monday", "Friday"],
        time: "9:00",
        period: "AM",
        timezone: "UTC",
      }),
    ).toBe("0 9 * * 1,5");
  });

  it("weekly multiple days PM", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "weekly",
        days: ["Monday", "Wednesday"],
        time: "8:00",
        period: "PM",
        timezone: "UTC",
      }),
    ).toBe("0 20 * * 1,3");
  });

  it("interval every 3 hours", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "interval",
        days: [],
        time: "3",
        period: "Hours",
        timezone: "UTC",
      }),
    ).toBe("0 */3 * * *");
  });

  it("interval every 6 hours", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "interval",
        days: [],
        time: "6",
        period: "Hours",
        timezone: "UTC",
      }),
    ).toBe("0 */6 * * *");
  });

  it("all 7 days normalizes to daily", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "weekly",
        days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        time: "9:00",
        period: "AM",
        timezone: "UTC",
      }),
    ).toBe("0 9 * * *");
  });

  it("days are sorted in numeric order", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "weekly",
        days: ["Friday", "Monday"],
        time: "9:00",
        period: "AM",
        timezone: "UTC",
      }),
    ).toBe("0 9 * * 1,5");
  });
});

describe("round-trip", () => {
  const cases: [string, ScheduleState][] = [
    [
      "hourly",
      { mode: "schedule", interval: "hourly", days: [], time: "", period: "AM", timezone: "UTC" },
    ],
    [
      "daily AM",
      {
        mode: "schedule",
        interval: "daily",
        days: [],
        time: "9:00",
        period: "AM",
        timezone: "UTC",
      },
    ],
    [
      "daily PM",
      {
        mode: "schedule",
        interval: "daily",
        days: [],
        time: "2:30",
        period: "PM",
        timezone: "UTC",
      },
    ],
    [
      "weekly",
      {
        mode: "schedule",
        interval: "weekly",
        days: ["Monday"],
        time: "9:00",
        period: "AM",
        timezone: "UTC",
      },
    ],
    [
      "weekly multiple days",
      {
        mode: "schedule",
        interval: "weekly",
        days: ["Monday", "Friday"],
        time: "9:00",
        period: "AM",
        timezone: "UTC",
      },
    ],
    [
      "interval every 6 hours",
      {
        mode: "schedule",
        interval: "interval",
        days: [],
        time: "6",
        period: "Hours",
        timezone: "UTC",
      },
    ],
    [
      "midnight",
      {
        mode: "schedule",
        interval: "daily",
        days: [],
        time: "12:00",
        period: "AM",
        timezone: "UTC",
      },
    ],
    [
      "noon",
      {
        mode: "schedule",
        interval: "daily",
        days: [],
        time: "12:00",
        period: "PM",
        timezone: "UTC",
      },
    ],
  ];

  it.each(cases)("%s: parseCron(buildCron(state)) === state", (_, state) => {
    expect(parseCron(buildCron(state))).toEqual(state);
  });
});

describe("buildCron edge cases", () => {
  it("empty time defaults to 9:00 AM", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "daily",
        days: [],
        time: "",
        period: "AM",
        timezone: "UTC",
      }),
    ).toBe("0 9 * * *");
  });

  it("empty time with Hours defaults to every 1 hour", () => {
    expect(
      buildCron({
        mode: "schedule",
        interval: "interval",
        days: [],
        time: "",
        period: "Hours",
        timezone: "UTC",
      }),
    ).toBe("0 */1 * * *");
  });
});

describe("normalizeTime", () => {
  // BUG #1: empty input rejected
  it("rejects empty string", () => {
    expect(normalizeTime("", "AM")).toBeNull();
  });

  it("rejects whitespace-only string", () => {
    expect(normalizeTime("   ", "PM")).toBeNull();
  });

  // BUG #2: partial input normalized to H:MM
  it('normalizes "5" to "5:00"', () => {
    expect(normalizeTime("5", "AM")).toEqual({ time: "5:00", period: "AM" });
  });

  it('normalizes "11" to "11:00"', () => {
    expect(normalizeTime("11", "PM")).toEqual({ time: "11:00", period: "PM" });
  });

  it('normalizes "5:" to "5:00"', () => {
    expect(normalizeTime("5:", "AM")).toEqual({ time: "5:00", period: "AM" });
  });

  // BUG #6: out-of-range hours rejected
  it("rejects hour 24", () => {
    expect(normalizeTime("24:00", "AM")).toBeNull();
  });

  it("rejects hour 25", () => {
    expect(normalizeTime("25:00", "PM")).toBeNull();
  });

  it("rejects hour 99", () => {
    expect(normalizeTime("99:99", "AM")).toBeNull();
  });

  it("rejects minute 60", () => {
    expect(normalizeTime("5:60", "AM")).toBeNull();
  });

  it("rejects negative hour", () => {
    expect(normalizeTime("-1:00", "AM")).toBeNull();
  });

  // 24h auto-conversion (existing behavior)
  it("converts hour 13 to 1:00 PM", () => {
    expect(normalizeTime("13:00", "AM")).toEqual({ time: "1:00", period: "PM" });
  });

  it("converts hour 23 to 11:00 PM", () => {
    expect(normalizeTime("23:30", "AM")).toEqual({ time: "11:30", period: "PM" });
  });

  it("converts hour 0 to 12:00 AM", () => {
    expect(normalizeTime("0:00", "PM")).toEqual({ time: "12:00", period: "AM" });
  });

  // Valid input passes through with normalization
  it("passes through valid 12h time with minute padding", () => {
    expect(normalizeTime("9:05", "AM")).toEqual({ time: "9:05", period: "AM" });
  });

  it("preserves period for valid 12h time", () => {
    expect(normalizeTime("3:30", "PM")).toEqual({ time: "3:30", period: "PM" });
  });

  it("normalizes 12:00 PM", () => {
    expect(normalizeTime("12:00", "PM")).toEqual({ time: "12:00", period: "PM" });
  });
});

describe("normalizeInterval", () => {
  // BUG #5: empty input rejected
  it("rejects empty string", () => {
    expect(normalizeInterval("")).toBeNull();
  });

  // BUG #4: zero rejected
  it("rejects 0", () => {
    expect(normalizeInterval("0")).toBeNull();
  });

  it("rejects negative values", () => {
    expect(normalizeInterval("-1")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(normalizeInterval("abc")).toBeNull();
  });

  // Valid input
  it("normalizes valid integer", () => {
    expect(normalizeInterval("2")).toBe("2");
  });

  it('normalizes "02" to "2"', () => {
    expect(normalizeInterval("02")).toBe("2");
  });

  it("accepts large intervals", () => {
    expect(normalizeInterval("24")).toBe("24");
  });
});
