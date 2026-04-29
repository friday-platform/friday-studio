import { describe, expect, it } from "vitest";
import { humanizeCronSchedule } from "./cron-humanize.ts";

describe("humanizeCronSchedule", () => {
  it.each([
    ["* * * * *", "Runs every minute (UTC)"],
    ["*/15 * * * *", "Runs every 15 minutes (UTC)"],
    ["0 * * * *", "Runs every hour at :00 (UTC)"],
    ["30 */2 * * *", "Runs every 2 hours at :30 (UTC)"],
    ["0 9 * * *", "Runs daily at 9:00 AM (UTC)"],
    ["0 9 * * 1-5", "Runs at 9:00 AM on weekdays (UTC)"],
    ["15 14 * * 1,3,5", "Runs at 2:15 PM on Mon, Wed, Fri (UTC)"],
    ["0 8 1 * *", "Runs at 8:00 AM on day 1 of the month (UTC)"],
    ["0 8 * 1,7 *", "Runs at 8:00 AM in Jan, Jul (UTC)"],
  ])("describes %s", (expr, expected) => {
    expect(humanizeCronSchedule(expr)).toBe(expected);
  });

  it("includes the configured timezone", () => {
    expect(humanizeCronSchedule("0 9 * * *", "America/New_York")).toBe(
      "Runs daily at 9:00 AM (America/New_York)",
    );
  });

  it("falls back for unsupported expressions", () => {
    expect(humanizeCronSchedule("not cron", "UTC")).toBe("Runs on cron schedule not cron (UTC)");
  });
});
