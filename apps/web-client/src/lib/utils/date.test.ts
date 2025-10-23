import { assertEquals } from "@std/assert";
import { formatChatDate } from "./date.ts";

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
