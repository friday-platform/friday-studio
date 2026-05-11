/**
 * Pin the production export-limit constants. Lives in its own file so it
 * imports the real module — the route's own tests `vi.mock` these values
 * down to test-friendly sizes, which means a typo (`50 * 1024` instead of
 * `50 * 1024 * 1024`) would ship without any of those suites failing.
 *
 * One regression guard for two cheap-to-typo numbers.
 */

import { describe, expect, it } from "vitest";
import { MAX_FULL_EXPORT_BYTES, MAX_FULL_EXPORT_MESSAGES } from "./chat-limits.ts";

describe("chat-limits production values", () => {
  it("MAX_FULL_EXPORT_MESSAGES is 5000", () => {
    expect(MAX_FULL_EXPORT_MESSAGES).toBe(5000);
  });

  it("MAX_FULL_EXPORT_BYTES is 50 MiB", () => {
    expect(MAX_FULL_EXPORT_BYTES).toBe(50 * 1024 * 1024);
  });
});
