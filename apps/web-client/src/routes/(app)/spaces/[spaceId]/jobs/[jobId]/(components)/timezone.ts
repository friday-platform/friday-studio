export interface TimezoneGroup {
  label: string;
  zones: string[];
}

export const TIMEZONE_GROUPS: TimezoneGroup[] = [
  {
    label: "Americas",
    zones: [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Anchorage",
      "America/Toronto",
      "America/Vancouver",
      "America/Mexico_City",
      "America/Sao_Paulo",
      "America/Argentina/Buenos_Aires",
      "America/Bogota",
    ],
  },
  {
    label: "Europe",
    zones: [
      "Europe/London",
      "Europe/Paris",
      "Europe/Berlin",
      "Europe/Amsterdam",
      "Europe/Madrid",
      "Europe/Rome",
      "Europe/Stockholm",
      "Europe/Warsaw",
      "Europe/Moscow",
      "Europe/Istanbul",
    ],
  },
  {
    label: "Africa",
    zones: ["Africa/Cairo", "Africa/Lagos", "Africa/Johannesburg", "Africa/Nairobi"],
  },
  {
    label: "Asia",
    zones: [
      "Asia/Dubai",
      "Asia/Kolkata",
      "Asia/Singapore",
      "Asia/Tokyo",
      "Asia/Shanghai",
      "Asia/Hong_Kong",
      "Asia/Seoul",
      "Asia/Bangkok",
      "Asia/Jakarta",
    ],
  },
  {
    label: "Pacific",
    zones: [
      "Pacific/Auckland",
      "Pacific/Honolulu",
      "Australia/Sydney",
      "Australia/Melbourne",
      "Australia/Perth",
    ],
  },
];

/** Replace underscores with spaces in a timezone string. */
export function formatTimezone(tz: string): string {
  return tz.replace(/_/g, " ");
}

/** Extract the city name from an IANA timezone (last segment, underscores → spaces). */
export function formatTimezoneCity(tz: string): string {
  const last = tz.split("/").pop();
  if (!last) return tz;
  return last.replace(/_/g, " ");
}

/** Get the UTC offset label (e.g. "GMT-5") for a timezone via Intl. */
export function formatUtcOffset(tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
    const parts = fmt.formatToParts(new Date());
    const offset = parts.find((p) => p.type === "timeZoneName");
    return offset?.value ?? "";
  } catch {
    return "";
  }
}

/** Get the current time string (e.g. "3:45 PM") for a timezone. */
export function formatCurrentTime(tz: string): string {
  try {
    return new Date().toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Get the numeric UTC offset in minutes for a timezone. */
export function getTimezoneOffset(tz: string): number {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
    const parts = fmt.formatToParts(now);
    const offsetPart = parts.find((p) => p.type === "timeZoneName");
    if (!offsetPart) return Infinity;
    const match = offsetPart.value.match(/GMT([+-]?\d+(?::\d+)?)/);
    if (!match) return 0;
    const [h, m] = (match[1] ?? "0").split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  } catch {
    return Infinity;
  }
}

/**
 * Build grouped timezone list with a "Suggested" group of the 6 closest
 * zones (3 behind, 3 ahead) to the user's timezone.
 */
export function buildTimezoneGroups(browserTimezone: string): TimezoneGroup[] {
  const userOffset = getTimezoneOffset(browserTimezone);

  const allZones = TIMEZONE_GROUPS.flatMap((g) => g.zones);
  const behind = allZones
    .filter((tz) => getTimezoneOffset(tz) <= userOffset)
    .sort((a, b) => getTimezoneOffset(b) - getTimezoneOffset(a))
    .slice(0, 3);
  const ahead = allZones
    .filter((tz) => getTimezoneOffset(tz) > userOffset)
    .sort((a, b) => getTimezoneOffset(a) - getTimezoneOffset(b))
    .slice(0, 3);
  const suggested = [...behind, ...ahead].sort(
    (a, b) => getTimezoneOffset(a) - getTimezoneOffset(b),
  );

  const sorted = TIMEZONE_GROUPS.map((group) => ({
    ...group,
    zones: [...group.zones].sort((a, b) => getTimezoneOffset(a) - getTimezoneOffset(b)),
  }));

  return [{ label: "Suggested", zones: suggested }, ...sorted];
}
