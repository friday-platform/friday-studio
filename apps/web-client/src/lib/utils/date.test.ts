import { describe, expect, it } from "vitest";
import {
  formatChatDate,
  formatDuration,
  formatFullDate,
  formatOutlineDate,
  formatSessionDate,
  getDatetimeContext,
} from "./date.ts";

describe("formatChatDate", () => {
  it("just now", () => {
    const now = new Date();
    const result = formatChatDate(now.toISOString());
    expect(result).toEqual("just now");
  });

  it("1 minute ago", () => {
    const date = new Date(Date.now() - 60000);
    const result = formatChatDate(date.toISOString());
    expect(result).toEqual("1 min ago");
  });

  it("30 minutes ago", () => {
    const date = new Date(Date.now() - 30 * 60000);
    const result = formatChatDate(date.toISOString());
    expect(result).toEqual("30 mins ago");
  });

  it("1 hour ago", () => {
    const date = new Date(Date.now() - 3600000);
    const result = formatChatDate(date.toISOString());
    expect(result).toEqual("1 hour ago");
  });

  it("5 hours ago", () => {
    const date = new Date(Date.now() - 5 * 3600000);
    const result = formatChatDate(date.toISOString());
    expect(result).toEqual("5 hours ago");
  });

  it("1 day ago", () => {
    const date = new Date(Date.now() - 86400000);
    const result = formatChatDate(date.toISOString());
    expect(result).toEqual("1 day ago");
  });

  it("3 days ago", () => {
    const date = new Date(Date.now() - 3 * 86400000);
    const result = formatChatDate(date.toISOString());
    expect(result).toEqual("3 days ago");
  });

  it("more than 1 week ago", () => {
    // 8 days ago at 5pm
    const date = new Date(Date.now() - 8 * 86400000);
    date.setHours(17, 0, 0, 0);
    const result = formatChatDate(date.toISOString());

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const expected = `${monthNames[date.getMonth()]} ${date.getDate()} at 5pm`;
    expect(result).toEqual(expected);
  });

  it("more than 1 week ago (am)", () => {
    // 10 days ago at 9am
    const date = new Date(Date.now() - 10 * 86400000);
    date.setHours(9, 0, 0, 0);
    const result = formatChatDate(date.toISOString());

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const expected = `${monthNames[date.getMonth()]} ${date.getDate()} at 9am`;
    expect(result).toEqual(expected);
  });

  it("more than 1 week ago (midnight)", () => {
    // 15 days ago at 12am
    const date = new Date(Date.now() - 15 * 86400000);
    date.setHours(0, 0, 0, 0);
    const result = formatChatDate(date.toISOString());

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const expected = `${monthNames[date.getMonth()]} ${date.getDate()} at 12am`;
    expect(result).toEqual(expected);
  });

  it("more than 1 week ago (noon)", () => {
    // 20 days ago at 12pm
    const date = new Date(Date.now() - 20 * 86400000);
    date.setHours(12, 0, 0, 0);
    const result = formatChatDate(date.toISOString());

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const expected = `${monthNames[date.getMonth()]} ${date.getDate()} at 12pm`;
    expect(result).toEqual(expected);
  });
});

describe("formatSessionDate", () => {
  it("basic formatting", () => {
    // October 28, 2024 at 1:38pm
    const date = new Date("2024-10-28T13:38:00Z");
    const result = formatSessionDate(date.toISOString());

    // Should contain full month name and day
    expect(result.includes("October 28 at")).toEqual(true);
    // Should contain time with am/pm
    expect(/\d{1,2}:\d{2}(am|pm)/.test(result)).toEqual(true);
    // Should contain timezone abbreviation
    expect(/[A-Z]{2,4}$/.test(result)).toEqual(true);
  });

  it("midnight as 12am", () => {
    const date = new Date(2024, 9, 28, 0, 0, 0, 0); // October 28, 2024 at midnight local
    const result = formatSessionDate(date.toISOString());

    expect(result.includes("12:00am")).toEqual(true);
  });

  it("noon as 12pm", () => {
    const date = new Date(2024, 9, 28, 12, 0, 0, 0); // October 28, 2024 at noon local
    const result = formatSessionDate(date.toISOString());

    expect(result.includes("12:00pm")).toEqual(true);
  });

  it("zero-padded minutes", () => {
    // 1:05pm
    const date = new Date("2024-10-28T13:05:00Z");
    const result = formatSessionDate(date.toISOString());

    expect(result.includes(":05")).toEqual(true);
  });
});

describe("formatDuration", () => {
  it("0 seconds", () => {
    const start = 1000;
    const end = 1000;
    expect(formatDuration(start, end)).toEqual("0 seconds");
  });

  it("1 second", () => {
    const start = 1000;
    const end = 2000;
    expect(formatDuration(start, end)).toEqual("1 second");
  });

  it("30 seconds", () => {
    const start = 1000;
    const end = 31000;
    expect(formatDuration(start, end)).toEqual("30 seconds");
  });

  it("59 seconds", () => {
    const start = 1000;
    const end = 60000;
    expect(formatDuration(start, end)).toEqual("59 seconds");
  });

  it("1 minute", () => {
    const start = 1000;
    const end = 61000;
    expect(formatDuration(start, end)).toEqual("1 minute");
  });

  it("1 minute 30 seconds", () => {
    const start = 1000;
    const end = 91000;
    expect(formatDuration(start, end)).toEqual("1 minute 30 seconds");
  });

  it("2 minutes", () => {
    const start = 1000;
    const end = 121000;
    expect(formatDuration(start, end)).toEqual("2 minutes");
  });

  it("30 minutes 45 seconds", () => {
    const start = 1000;
    const end = 1846000;
    expect(formatDuration(start, end)).toEqual("30 minutes 45 seconds");
  });

  it("59 minutes 59 seconds", () => {
    const start = 1000;
    const end = 3600000;
    expect(formatDuration(start, end)).toEqual("59 minutes 59 seconds");
  });

  it("1 hour", () => {
    const start = 1000;
    const end = 3601000;
    expect(formatDuration(start, end)).toEqual("1 hour");
  });

  it("1 hour 1 second", () => {
    const start = 1000;
    const end = 3602000;
    expect(formatDuration(start, end)).toEqual("1 hour 1 second");
  });

  it("1 hour 1 minute", () => {
    const start = 1000;
    const end = 3661000;
    expect(formatDuration(start, end)).toEqual("1 hour 1 minute");
  });

  it("1 hour 1 minute 1 second", () => {
    const start = 1000;
    const end = 3662000;
    expect(formatDuration(start, end)).toEqual("1 hour 1 minute 1 second");
  });

  it("2 hours 30 minutes 15 seconds", () => {
    const start = 1000;
    const end = 9016000;
    expect(formatDuration(start, end)).toEqual("2 hours 30 minutes 15 seconds");
  });

  it("2 hours 15 seconds (no minutes)", () => {
    const start = 1000;
    const end = 7216000;
    expect(formatDuration(start, end)).toEqual("2 hours 15 seconds");
  });

  it("3 hours 30 minutes (no seconds)", () => {
    const start = 1000;
    const end = 12601000;
    expect(formatDuration(start, end)).toEqual("3 hours 30 minutes");
  });
});

describe("formatOutlineDate", () => {
  it("today", () => {
    const now = new Date();
    const result = formatOutlineDate(now.toISOString());
    const hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "pm" : "am";
    const displayHours = hours % 12 || 12;
    expect(result).toEqual(`Today at ${displayHours}:${minutes}${ampm}`);
  });

  it("yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const result = formatOutlineDate(yesterday.toISOString());
    const hours = yesterday.getHours();
    const minutes = yesterday.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "pm" : "am";
    const displayHours = hours % 12 || 12;
    expect(result).toEqual(`Yesterday at ${displayHours}:${minutes}${ampm}`);
  });

  it("same year, older than yesterday", () => {
    // Use explicit mid-year date to avoid year boundary issues in early January
    const now = new Date();
    const date = new Date(now.getFullYear(), 5, 15, 14, 30, 0, 0); // June 15, current year
    const result = formatOutlineDate(date.toISOString());
    expect(result).toEqual(`June 15 at 2:30pm`);
  });

  it("different year", () => {
    const date = new Date(2023, 5, 15, 9, 15, 0, 0);
    const result = formatOutlineDate(date.toISOString());
    expect(result).toEqual("Jun 15, 2023 at 9:15am");
  });

  it("midnight (12am)", () => {
    // Use explicit mid-year date to avoid year boundary issues in early January
    const now = new Date();
    const date = new Date(now.getFullYear(), 6, 20, 0, 0, 0, 0); // July 20, current year, midnight
    const result = formatOutlineDate(date.toISOString());
    expect(result).toEqual(`July 20 at 12:00am`);
  });

  it("noon (12pm)", () => {
    // Use explicit mid-year date to avoid year boundary issues in early January
    const now = new Date();
    const date = new Date(now.getFullYear(), 6, 20, 12, 0, 0, 0); // July 20, current year, noon
    const result = formatOutlineDate(date.toISOString());
    expect(result).toEqual(`July 20 at 12:00pm`);
  });

  it("zero-padded minutes", () => {
    const date = new Date();
    date.setDate(date.getDate() - 3);
    date.setHours(9, 5, 0, 0);
    const result = formatOutlineDate(date.toISOString());
    expect(result.includes(":05")).toEqual(true);
  });

  it("accepts number timestamp", () => {
    const date = new Date(2023, 2, 20, 15, 45, 0, 0);
    const timestamp = date.getTime();
    const result = formatOutlineDate(timestamp);
    expect(result).toEqual("Mar 20, 2023 at 3:45pm");
  });
});

describe("formatFullDate", () => {
  it("basic formatting", () => {
    const date = new Date(2025, 11, 30, 0, 0, 0, 0); // December 30, 2025
    const result = formatFullDate(date.toISOString());
    expect(result).toEqual("December 30, 2025");
  });

  it("single digit day", () => {
    const date = new Date(2025, 0, 5, 0, 0, 0, 0); // January 5, 2025
    const result = formatFullDate(date.toISOString());
    expect(result).toEqual("January 5, 2025");
  });

  it("different year", () => {
    const date = new Date(2024, 6, 4, 0, 0, 0, 0); // July 4, 2024
    const result = formatFullDate(date.toISOString());
    expect(result).toEqual("July 4, 2024");
  });

  it("accepts number timestamp", () => {
    const date = new Date(2025, 2, 15, 10, 30, 0, 0); // March 15, 2025
    const timestamp = date.getTime();
    const result = formatFullDate(timestamp);
    expect(result).toEqual("March 15, 2025");
  });
});

describe("getDatetimeContext", () => {
  it("timezoneOffset matches ±HH:MM pattern", () => {
    const ctx = getDatetimeContext();
    const offsetPattern = /^[+-]\d{2}:\d{2}$/;
    expect(offsetPattern.test(ctx.timezoneOffset)).toEqual(true);
  });

  it("returns all required fields", () => {
    const ctx = getDatetimeContext();
    expect(typeof ctx.timezone).toEqual("string");
    expect(typeof ctx.timestamp).toEqual("string");
    expect(typeof ctx.localDate).toEqual("string");
    expect(typeof ctx.localTime).toEqual("string");
    expect(typeof ctx.timezoneOffset).toEqual("string");
  });

  it("timestamp contains timezone offset", () => {
    const ctx = getDatetimeContext();
    // Timestamp should end with the timezone offset
    expect(ctx.timestamp.endsWith(ctx.timezoneOffset)).toEqual(true);
  });
});
