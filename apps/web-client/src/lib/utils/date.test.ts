import { assertEquals } from "@std/assert";
import { formatChatDate, formatDuration, formatSessionDate } from "./date.ts";

Deno.test("formatChatDate - just now", () => {
  const now = new Date();
  const result = formatChatDate(now.toISOString());
  assertEquals(result, "just now");
});

Deno.test("formatChatDate - 1 minute ago", () => {
  const date = new Date(Date.now() - 60000);
  const result = formatChatDate(date.toISOString());
  assertEquals(result, "1 min ago");
});

Deno.test("formatChatDate - 30 minutes ago", () => {
  const date = new Date(Date.now() - 30 * 60000);
  const result = formatChatDate(date.toISOString());
  assertEquals(result, "30 mins ago");
});

Deno.test("formatChatDate - 1 hour ago", () => {
  const date = new Date(Date.now() - 3600000);
  const result = formatChatDate(date.toISOString());
  assertEquals(result, "1 hour ago");
});

Deno.test("formatChatDate - 5 hours ago", () => {
  const date = new Date(Date.now() - 5 * 3600000);
  const result = formatChatDate(date.toISOString());
  assertEquals(result, "5 hours ago");
});

Deno.test("formatChatDate - 1 day ago", () => {
  const date = new Date(Date.now() - 86400000);
  const result = formatChatDate(date.toISOString());
  assertEquals(result, "1 day ago");
});

Deno.test("formatChatDate - 3 days ago", () => {
  const date = new Date(Date.now() - 3 * 86400000);
  const result = formatChatDate(date.toISOString());
  assertEquals(result, "3 days ago");
});

Deno.test("formatChatDate - more than 1 week ago", () => {
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
  assertEquals(result, expected);
});

Deno.test("formatChatDate - more than 1 week ago (am)", () => {
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
  assertEquals(result, expected);
});

Deno.test("formatChatDate - more than 1 week ago (midnight)", () => {
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
  assertEquals(result, expected);
});

Deno.test("formatChatDate - more than 1 week ago (noon)", () => {
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
  assertEquals(result, expected);
});

Deno.test("formatSessionDate - basic formatting", () => {
  // October 28, 2024 at 1:38pm
  const date = new Date("2024-10-28T13:38:00Z");
  const result = formatSessionDate(date.toISOString());

  // Should contain full month name and day
  assertEquals(result.includes("October 28 at"), true);
  // Should contain time with am/pm
  assertEquals(/\d{1,2}:\d{2}(am|pm)/.test(result), true);
  // Should contain timezone abbreviation
  assertEquals(/[A-Z]{2,4}$/.test(result), true);
});

Deno.test("formatSessionDate - midnight as 12am", () => {
  const date = new Date(2024, 9, 28, 0, 0, 0, 0); // October 28, 2024 at midnight local
  const result = formatSessionDate(date.toISOString());

  assertEquals(result.includes("12:00am"), true);
});

Deno.test("formatSessionDate - noon as 12pm", () => {
  const date = new Date(2024, 9, 28, 12, 0, 0, 0); // October 28, 2024 at noon local
  const result = formatSessionDate(date.toISOString());

  assertEquals(result.includes("12:00pm"), true);
});

Deno.test("formatSessionDate - zero-padded minutes", () => {
  // 1:05pm
  const date = new Date("2024-10-28T13:05:00Z");
  const result = formatSessionDate(date.toISOString());

  assertEquals(result.includes(":05"), true);
});

Deno.test("formatDuration - 0 seconds", () => {
  const start = 1000;
  const end = 1000;
  assertEquals(formatDuration(start, end), "0 seconds");
});

Deno.test("formatDuration - 1 second", () => {
  const start = 1000;
  const end = 2000;
  assertEquals(formatDuration(start, end), "1 second");
});

Deno.test("formatDuration - 30 seconds", () => {
  const start = 1000;
  const end = 31000;
  assertEquals(formatDuration(start, end), "30 seconds");
});

Deno.test("formatDuration - 59 seconds", () => {
  const start = 1000;
  const end = 60000;
  assertEquals(formatDuration(start, end), "59 seconds");
});

Deno.test("formatDuration - 1 minute", () => {
  const start = 1000;
  const end = 61000;
  assertEquals(formatDuration(start, end), "1 minute");
});

Deno.test("formatDuration - 1 minute 30 seconds", () => {
  const start = 1000;
  const end = 91000;
  assertEquals(formatDuration(start, end), "1 minute 30 seconds");
});

Deno.test("formatDuration - 2 minutes", () => {
  const start = 1000;
  const end = 121000;
  assertEquals(formatDuration(start, end), "2 minutes");
});

Deno.test("formatDuration - 30 minutes 45 seconds", () => {
  const start = 1000;
  const end = 1846000;
  assertEquals(formatDuration(start, end), "30 minutes 45 seconds");
});

Deno.test("formatDuration - 59 minutes 59 seconds", () => {
  const start = 1000;
  const end = 3600000;
  assertEquals(formatDuration(start, end), "59 minutes 59 seconds");
});

Deno.test("formatDuration - 1 hour", () => {
  const start = 1000;
  const end = 3601000;
  assertEquals(formatDuration(start, end), "1 hour");
});

Deno.test("formatDuration - 1 hour 1 second", () => {
  const start = 1000;
  const end = 3602000;
  assertEquals(formatDuration(start, end), "1 hour 1 second");
});

Deno.test("formatDuration - 1 hour 1 minute", () => {
  const start = 1000;
  const end = 3661000;
  assertEquals(formatDuration(start, end), "1 hour 1 minute");
});

Deno.test("formatDuration - 1 hour 1 minute 1 second", () => {
  const start = 1000;
  const end = 3662000;
  assertEquals(formatDuration(start, end), "1 hour 1 minute 1 second");
});

Deno.test("formatDuration - 2 hours 30 minutes 15 seconds", () => {
  const start = 1000;
  const end = 9016000;
  assertEquals(formatDuration(start, end), "2 hours 30 minutes 15 seconds");
});

Deno.test("formatDuration - 2 hours 15 seconds (no minutes)", () => {
  const start = 1000;
  const end = 7216000;
  assertEquals(formatDuration(start, end), "2 hours 15 seconds");
});

Deno.test("formatDuration - 3 hours 30 minutes (no seconds)", () => {
  const start = 1000;
  const end = 12601000;
  assertEquals(formatDuration(start, end), "3 hours 30 minutes");
});
