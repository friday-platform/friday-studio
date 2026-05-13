const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "",
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

export function humanizeCronSchedule(expr: string, timezone = "UTC"): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return fallback(expr, timezone);

  const minute = parts[0];
  const hour = parts[1];
  const dayOfMonth = parts[2];
  const month = parts[3];
  const dayOfWeek = parts[4];
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return fallback(expr, timezone);

  const minuteInterval = intervalValue(minute);
  const hourInterval = intervalValue(hour);
  const minuteNumber = numberValue(minute, 0, 59);
  const hourNumber = numberValue(hour, 0, 23);
  const constraints = describeConstraints(dayOfMonth, month, dayOfWeek);
  const suffix = timezone ? ` (${timezone})` : "";

  if (minute === "*" && hour === "*") {
    return sentence("every minute", constraints, suffix);
  }
  if (minuteInterval && hour === "*") {
    return sentence(`every ${plural(minuteInterval, "minute")}`, constraints, suffix);
  }
  if (minuteNumber !== null && hour === "*") {
    return sentence(`every hour at :${String(minuteNumber).padStart(2, "0")}`, constraints, suffix);
  }
  if (minuteNumber !== null && hourInterval) {
    return sentence(
      `every ${plural(hourInterval, "hour")} at :${String(minuteNumber).padStart(2, "0")}`,
      constraints,
      suffix,
    );
  }
  if (minuteNumber !== null && hourNumber !== null) {
    const cadence = constraints.length > 0 ? "" : "daily ";
    return sentence(`${cadence}at ${formatTime(hourNumber, minuteNumber)}`, constraints, suffix);
  }

  return fallback(expr, timezone);
}

function sentence(base: string, constraints: string[], suffix: string): string {
  const qualifier = constraints.length > 0 ? ` ${constraints.join(" ")}` : "";
  return `Runs ${base}${qualifier}${suffix}`;
}

function describeConstraints(dayOfMonth: string, month: string, dayOfWeek: string): string[] {
  const constraints: string[] = [];
  const days = describeDayOfWeek(dayOfWeek);
  if (days) constraints.push(days);
  if (dayOfMonth !== "*") constraints.push(`on day ${dayOfMonth} of the month`);
  const months = describeList(month, MONTH_NAMES, 1, 12);
  if (months) constraints.push(`in ${months}`);
  return constraints;
}

function describeDayOfWeek(value: string): string | null {
  if (value === "*") return null;
  if (value === "1-5") return "on weekdays";
  if (value === "0,6" || value === "6,0") return "on weekends";
  const days = describeList(value, DAY_NAMES, 0, 7);
  return days ? `on ${days}` : `on ${value}`;
}

function describeList(value: string, labels: string[], min: number, max: number): string | null {
  if (value === "*") return null;
  const names: string[] = [];
  for (const token of value.split(",")) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = numberValue(range[1] ?? "", min, max);
      const end = numberValue(range[2] ?? "", min, max);
      if (start !== null && end !== null) {
        names.push(`${labelFor(start, labels)}-${labelFor(end, labels)}`);
        continue;
      }
    }
    const numeric = numberValue(token, min, max);
    names.push(numeric === null ? token : labelFor(numeric, labels));
  }
  return names.length > 0 ? names.join(", ") : null;
}

function labelFor(value: number, labels: string[]): string {
  const normalized = value === 7 && labels.length === 7 ? 0 : value;
  return labels[normalized] ?? String(value);
}

function intervalValue(value: string): number | null {
  const match = value.match(/^\*\/(\d+)$/);
  if (!match) return null;
  return numberValue(match[1] ?? "", 1, Number.MAX_SAFE_INTEGER);
}

function numberValue(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return null;
  return number;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function formatTime(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function fallback(expr: string, timezone: string): string {
  return timezone ? `Runs on cron schedule ${expr} (${timezone})` : `Runs on cron schedule ${expr}`;
}
