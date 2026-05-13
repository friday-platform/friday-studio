/**
 * Formats a duration between two timestamps as human-readable text.
 * Minimum output is "1 second" to avoid "0 seconds" on initial display.
 */
export function formatDuration(startMs: number, endMs: number): string {
  const totalSeconds = Math.max(1, Math.round((endMs - startMs) / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}${minutes > 0 ? ` ${minutes} minute${minutes === 1 ? "" : "s"}` : ""}${seconds > 0 ? ` ${seconds} second${seconds === 1 ? "" : "s"}` : ""}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}${seconds > 0 ? ` ${seconds} second${seconds === 1 ? "" : "s"}` : ""}`;
}

/**
 * Formats a date for session details with full month name and timezone.
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

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzAbbr = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  return `${month} ${day} at ${displayHours}:${displayMinutes}${ampm} ${tzAbbr}`;
}
