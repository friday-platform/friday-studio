/**
 * Formats a date for chat messages with relative time for recent dates.
 *
 * @example
 * // Recent times (< 1 week)
 * formatChatDate(Date.now() - 30000)      // "just now"
 * formatChatDate(Date.now() - 300000)     // "5 mins ago"
 * formatChatDate(Date.now() - 7200000)    // "2 hours ago"
 * formatChatDate(Date.now() - 172800000)  // "2 days ago"
 *
 * // Older dates (> 1 week)
 * formatChatDate("2025-10-25T17:00:00Z")  // "Oct 25 at 5pm"
 * formatChatDate("2025-03-10T09:00:00Z")  // "Mar 10 at 9am"
 */
export function formatChatDate(dateString: string | number): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  // Less than 1 week ago: use relative time
  if (diffDays < 7) {
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins} min${diffMins === 1 ? "" : "s"} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  }

  // More than 1 week ago: use "Oct 25 at 5pm" format
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
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const hours = date.getHours();
  const ampm = hours >= 12 ? "pm" : "am";
  const displayHours = hours % 12 || 12;

  return `${month} ${day} at ${displayHours}${ampm}`;
}

/**
 * Formats a date for session details with full month name and timezone.
 *
 * @example
 * formatSessionDate("2025-03-15T14:30:00Z")  // "March 15 at 2:30pm PST"
 * formatSessionDate("2025-12-25T09:05:00Z")  // "December 25 at 9:05am PST"
 * formatSessionDate("2025-07-04T00:00:00Z")  // "July 4 at 12:00am PST"
 */
export function formatSessionDate(dateString: string | number): string {
  const date = new Date(dateString);
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, "0");

  // Get timezone abbreviation
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzAbbr = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  return `${month} ${day} at ${displayHours}:${displayMinutes}${ampm} ${tzAbbr}`;
}

/**
 * Formats a duration between two timestamps as human-readable text.
 * Minimum output is "1 second" to avoid "0 seconds" on initial display.
 *
 * @example
 * formatDuration(0, 0)         // "1 second" (minimum)
 * formatDuration(0, 500)       // "1 second" (minimum)
 * formatDuration(0, 5000)      // "5 seconds"
 * formatDuration(0, 65000)     // "1 minute 5 seconds"
 * formatDuration(0, 3600000)   // "1 hour"
 * formatDuration(0, 3723000)   // "1 hour 2 minutes 3 seconds"
 * formatDuration(0, 7380000)   // "2 hours 3 minutes"
 */
export function formatDuration(startMs: number, endMs: number): string {
  // Minimum 1 second to avoid "0 seconds" on initial display
  const totalSeconds = Math.max(1, Math.round((endMs - startMs) / 1000));

  // If under 60 seconds, just show seconds
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }

  // Calculate hours, minutes, seconds
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // If over an hour, show all components (e.g. "1 hour 2 minutes 3 seconds")
  if (hours > 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}${minutes > 0 ? ` ${minutes} minute${minutes === 1 ? "" : "s"}` : ""}${seconds > 0 ? ` ${seconds} second${seconds === 1 ? "" : "s"}` : ""}`;
  }
  // If at least a minute, show minutes (and seconds if any)
  return `${minutes} minute${minutes === 1 ? "" : "s"}${seconds > 0 ? ` ${seconds} second${seconds === 1 ? "" : "s"}` : ""}`;
}

/**
 * Formats a date as full month name, day, and year.
 *
 * @example
 * formatFullDate("2025-12-30T00:00:00Z")  // "December 30, 2025"
 * formatFullDate("2025-01-15T10:30:00Z")  // "January 15, 2025"
 * formatFullDate("2024-07-04T00:00:00Z")  // "July 4, 2024"
 */
export function formatFullDate(dateInput: string | number): string {
  const date = new Date(dateInput);
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  return `${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * Formats a date for conversation timelines with contextual formatting.
 *
 * @example
 * // Today
 * formatOutlineDate(Date.now())                // "Today at 9:07am"
 *
 * // Yesterday
 * formatOutlineDate(Date.now() - 86400000)     // "Yesterday at 10:31pm"
 *
 * // Same year (older than yesterday)
 * formatOutlineDate("2025-12-02T17:51:00Z")    // "December 2 at 5:51pm"
 *
 * // Different year
 * formatOutlineDate("2024-11-03T04:30:00Z")    // "Nov 3, 2024 at 4:30am"
 */
export function formatOutlineDate(dateInput: string | number): string {
  const date = new Date(dateInput);
  const now = new Date();

  const dateYear = date.getFullYear();
  const nowYear = now.getFullYear();

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const shortMonthNames = [
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

  function pad(num: number) {
    return num.toString().padStart(2, "0");
  }

  const hours = date.getHours();
  const minutes = pad(date.getMinutes());
  const ampm = hours >= 12 ? "pm" : "am";
  const displayHours = hours % 12 || 12;

  const dateDay = date.getDate();
  const nowDay = now.getDate();

  // Same day
  if (nowYear === dateYear && now.getMonth() === date.getMonth() && nowDay === dateDay) {
    return `Today at ${displayHours}:${minutes}${ampm}`;
  }

  // Yesterday
  const oneDayAgo = new Date(now);
  oneDayAgo.setDate(nowDay - 1);
  if (
    nowYear === dateYear &&
    oneDayAgo.getMonth() === date.getMonth() &&
    oneDayAgo.getDate() === dateDay
  ) {
    return `Yesterday at ${displayHours}:${minutes}${ampm}`;
  }

  // Last 48h fallback (may not hit above, but for completeness)
  const diffMs = now.getTime() - date.getTime();
  const diffHrs = diffMs / 3600000;
  if (diffHrs < 48 && diffMs > 0) {
    // Fallback to today/yesterday already returned; use month+day
    return `${monthNames[date.getMonth()]} ${dateDay} at ${displayHours}:${minutes}${ampm}`;
  }

  // Same year, but older than yesterday
  if (nowYear === dateYear) {
    return `${monthNames[date.getMonth()]} ${dateDay} at ${displayHours}:${minutes}${ampm}`;
  }

  // Different year
  return `${shortMonthNames[date.getMonth()]} ${dateDay}, ${dateYear} at ${displayHours}:${minutes}${ampm}`;
}

export interface DatetimeContext {
  timezone: string; // IANA e.g. 'America/Los_Angeles'
  timestamp: string; // ISO8601 with offset e.g. '2026-01-08T12:44:39-08:00'
  localDate: string; // e.g. 'Thursday, January 8, 2026'
  localTime: string; // e.g. '12:44 PM'
  timezoneOffset: string; // e.g. '-08:00'
}

export function getDatetimeContext(): DatetimeContext {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMinutes = now.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const offsetSign = offsetMinutes <= 0 ? "+" : "-";
  const timezoneOffset = `${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMins).padStart(2, "0")}`;

  // Build local ISO timestamp
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${timezoneOffset}`;

  return {
    timezone,
    timestamp,
    localDate: now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    localTime: now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    timezoneOffset,
  };
}
