import { describe, expect, it } from "vitest";
import type { ScheduleState } from "./cron.ts";
import { contiguousRange, frequencyLabel } from "./schedule-label.ts";

const BASE: ScheduleState = {
  mode: "schedule",
  interval: "weekly",
  days: [],
  time: "9:00",
  period: "AM",
  timezone: "UTC",
};

describe("contiguousRange", () => {
  it("returns null for fewer than 2 days", () => {
    expect(contiguousRange(["Monday"])).toBeNull();
    expect(contiguousRange([])).toBeNull();
  });

  it("detects Mon-Fri as contiguous", () => {
    expect(contiguousRange(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])).toEqual([
      "Monday",
      "Friday",
    ]);
  });

  it("detects Mon-Wed as contiguous", () => {
    expect(contiguousRange(["Monday", "Tuesday", "Wednesday"])).toEqual(["Monday", "Wednesday"]);
  });

  it("returns null for non-contiguous days", () => {
    expect(contiguousRange(["Monday", "Wednesday", "Friday"])).toBeNull();
  });

  it("detects Sat-Sun as contiguous (wraps at end of DAYS array)", () => {
    expect(contiguousRange(["Saturday", "Sunday"])).toBeNull();
  });

  it("detects Thu-Sat as contiguous", () => {
    expect(contiguousRange(["Thursday", "Friday", "Saturday"])).toEqual(["Thursday", "Saturday"]);
  });
});

describe("frequencyLabel", () => {
  it("returns Manual for manual mode", () => {
    expect(frequencyLabel({ ...BASE, mode: "manual" })).toBe("Manual");
  });

  it("returns Every hour for hourly", () => {
    expect(frequencyLabel({ ...BASE, interval: "hourly" })).toBe("Every hour");
  });

  it("returns Every day for daily", () => {
    expect(frequencyLabel({ ...BASE, interval: "daily" })).toBe("Every day");
  });

  it("returns Interval for interval", () => {
    expect(frequencyLabel({ ...BASE, interval: "interval" })).toBe("Interval");
  });

  it("returns Weekly when no days selected", () => {
    expect(frequencyLabel({ ...BASE, days: [] })).toBe("Weekly");
  });

  it("returns Every Day when all 7 days selected", () => {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    expect(frequencyLabel({ ...BASE, days })).toBe("Every Day");
  });

  it("returns Every Weekday for Mon-Fri", () => {
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    expect(frequencyLabel({ ...BASE, days })).toBe("Every Weekday");
  });

  it("returns range label for 4+ contiguous days", () => {
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday"];
    expect(frequencyLabel({ ...BASE, days })).toBe("Every Monday-Thursday");
  });

  it("returns comma-joined label for 4+ non-contiguous days", () => {
    const days = ["Monday", "Wednesday", "Thursday", "Saturday"];
    expect(frequencyLabel({ ...BASE, days })).toBe(
      "Every Monday, Wednesday, Thursday and Saturday",
    );
  });

  it("returns single day name", () => {
    expect(frequencyLabel({ ...BASE, days: ["Monday"] })).toBe("Every Monday");
  });

  it("joins two days with and", () => {
    expect(frequencyLabel({ ...BASE, days: ["Monday", "Friday"] })).toBe("Every Monday and Friday");
  });

  it("joins three days with commas and and", () => {
    expect(frequencyLabel({ ...BASE, days: ["Monday", "Wednesday", "Friday"] })).toBe(
      "Every Monday, Wednesday and Friday",
    );
  });
});
