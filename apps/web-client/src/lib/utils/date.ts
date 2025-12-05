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

export function formatDuration(startMs: number, endMs: number): string {
  const totalSeconds = endMs <= startMs ? 0 : Math.round((endMs - startMs) / 1000);

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
 * Formats a date for conversation timelines:
 * - Within the last 48 hours: "Today at 9:07am" / "Yesterday at 10:31pm"
 * - Within the current year: "December 2 at 5:51pm"
 * - Otherwise: "Nov 3, 2024 at 4:30am"
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
