export type Mode = "manual" | "schedule";
export type Interval = "hourly" | "daily" | "weekly" | "interval";
export type Period = "AM" | "PM" | "Hours";

export interface ScheduleState {
  mode: Mode;
  interval: Interval;
  days: string[];
  time: string;
  period: Period;
  timezone: string;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayNameToNumber(name: string): number {
  return DAYS.indexOf(name);
}

function to24Hour(time: string, period: Period): { hour: number; minute: number } {
  if (period === "Hours") {
    const h = parseInt(time, 10);
    return { hour: isNaN(h) ? 1 : h, minute: 0 };
  }

  const timeParts = time.split(":");
  const rawHour = parseInt(timeParts[0] ?? "0", 10);
  const hour12 = isNaN(rawHour) ? 9 : rawHour;
  const rawMinute = parseInt(timeParts[1] ?? "0", 10);
  const minute = isNaN(rawMinute) ? 0 : rawMinute;

  let hour24: number;
  if (period === "AM") {
    hour24 = hour12 === 12 ? 0 : hour12;
  } else {
    hour24 = hour12 === 12 ? 12 : hour12 + 12;
  }

  return { hour: hour24, minute };
}

function to12Hour(hour24: number): { hour: number; period: "AM" | "PM" } {
  if (hour24 === 0) return { hour: 12, period: "AM" };
  if (hour24 < 12) return { hour: hour24, period: "AM" };
  if (hour24 === 12) return { hour: 12, period: "PM" };
  return { hour: hour24 - 12, period: "PM" };
}

export function parseCron(cron: string): ScheduleState {
  const parts = cron.trim().split(/\s+/);
  const minuteStr = parts[0] ?? "0";
  const hourStr = parts[1] ?? "*";
  const dayOfWeekStr = parts[4] ?? "*";

  const base = { mode: "schedule" as const, timezone: "UTC" };

  // Hourly: hour is "*"
  if (hourStr === "*") {
    return { ...base, interval: "hourly", days: [], time: "", period: "AM" };
  }

  // Interval: hour contains */N
  if (hourStr.startsWith("*/")) {
    const every = hourStr.slice(2);
    return { ...base, interval: "interval", days: [], time: every, period: "Hours" };
  }

  // AM/PM: parse hour and minute
  const hour24 = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const { hour, period } = to12Hour(hour24);
  const time = `${hour}:${String(minute).padStart(2, "0")}`;

  // Day of week parsing
  if (dayOfWeekStr === "*") {
    return { ...base, interval: "daily", days: [], time, period };
  }

  const dayNumbers = dayOfWeekStr.split(",").map((d) => parseInt(d, 10));
  const days = dayNumbers.map((d) => DAYS[d] ?? "");

  return { ...base, interval: "weekly", days, time, period };
}

/**
 * Validate and normalize a 12h time string (e.g. "5" → "5:00", "14:30" → "2:30" PM).
 * Returns null if input is invalid (empty, out of range, NaN).
 */
export function normalizeTime(
  time: string,
  period: "AM" | "PM",
): { time: string; period: "AM" | "PM" } | null {
  if (time.trim() === "") return null;

  const parts = time.split(":");
  const h = parseInt(parts[0] ?? "", 10);
  const rawM = parseInt(parts[1] ?? "0", 10);
  const m = isNaN(rawM) ? 0 : rawM;

  if (isNaN(h) || h > 23 || h < 0 || m > 59 || m < 0) return null;

  if (h >= 13 && h <= 23) {
    return { time: `${h - 12}:${String(m).padStart(2, "0")}`, period: "PM" };
  }
  if (h === 0) {
    return { time: `12:${String(m).padStart(2, "0")}`, period: "AM" };
  }
  return { time: `${h}:${String(m).padStart(2, "0")}`, period };
}

/**
 * Validate and normalize an interval hours string (e.g. "02" → "2").
 * Returns null if input is invalid (empty, NaN, or < 1).
 */
export function normalizeInterval(time: string): string | null {
  const hours = parseInt(time, 10);
  if (isNaN(hours) || hours < 1) return null;
  return String(hours);
}

export function buildCron(state: ScheduleState): string {
  if (state.interval === "hourly") {
    return "0 * * * *";
  }

  if (state.interval === "interval") {
    const hours = parseInt(state.time, 10);
    return `0 */${isNaN(hours) ? 1 : hours} * * *`;
  }

  // daily or weekly — resolve day-of-week field
  let dowField: string;
  if (state.interval === "daily") {
    dowField = "*";
  } else {
    const dayNumbers = state.days.map(dayNameToNumber).sort((a, b) => a - b);
    dowField = dayNumbers.length === 7 ? "*" : dayNumbers.join(",");
  }

  const { hour, minute } = to24Hour(state.time, state.period);
  return `${minute} ${hour} * * ${dowField}`;
}
