import type { ScheduleState } from "./cron.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/** Check if selected days form a contiguous run in the week. */
export function contiguousRange(days: string[]): [string, string] | null {
  if (days.length < 2) return null;
  const indices = days.map((d) => DAYS.indexOf(d)).sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1]! + 1) return null;
  }
  return [DAYS[indices[0]!]!, DAYS[indices.at(-1)!]!];
}

/** Derive the human-readable frequency label from schedule state. */
export function frequencyLabel(sched: ScheduleState): string {
  if (sched.mode === "manual") return "Manual";
  if (sched.interval === "hourly") return "Every hour";
  if (sched.interval === "daily") return "Every day";
  if (sched.interval === "interval") return "Interval";
  // weekly
  if (sched.days.length === 7) return "Every Day";
  if (sched.days.length === 0) return "Weekly";
  if (sched.days.length === 5 && WEEKDAYS.every((d) => sched.days.includes(d)))
    return "Every Weekday";
  if (sched.days.length > 3) {
    const range = contiguousRange(sched.days);
    if (range) return `Every ${range[0]}-${range[1]}`;
    return `Every ${sched.days.slice(0, -1).join(", ")} and ${sched.days.at(-1)}`;
  }
  return `Every ${sched.days.slice(0, -1).join(", ")}${sched.days.length > 1 ? " and " : ""}${sched.days.at(-1)}`;
}
