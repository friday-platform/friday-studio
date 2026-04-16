/**
 * Temporal grounding for LLM prompts.
 *
 * Centralizes date/time context injection so every LLM call gets
 * consistent, timezone-aware temporal grounding.
 */
/**
 * Client-provided datetime context with timezone awareness.
 * Sent from web client with the user's local timezone info.
 */
export interface DatetimeContext {
  /** IANA timezone e.g. 'America/Los_Angeles' */
  timezone: string;
  /** ISO8601 with offset e.g. '2026-01-08T12:44:39-08:00' */
  timestamp: string;
  /** Human-readable local date e.g. 'Thursday, January 8, 2026' */
  localDate: string;
  /** Human-readable local time e.g. '12:44 PM' */
  localTime: string;
  /** UTC offset e.g. '-08:00' */
  timezoneOffset: string;
  /** Browser geolocation latitude (optional) */
  latitude?: string;
  /** Browser geolocation longitude (optional) */
  longitude?: string;
}

/**
 * Build a temporal grounding facts section for LLM prompts.
 *
 * When client-provided DatetimeContext is available, uses the user's
 * local timezone. Otherwise falls back to server time with explicit
 * timezone annotation so the LLM knows which timezone the date is in.
 */
export function buildTemporalFacts(datetime?: DatetimeContext): string {
  if (datetime) {
    const facts = [
      `## Context Facts`,
      `- Current Date: ${datetime.localDate}`,
      `- Current Time: ${datetime.localTime} (${datetime.timezone})`,
      `- Timestamp: ${datetime.timestamp}`,
      `- Timezone Offset: ${datetime.timezoneOffset}`,
    ];
    if (datetime.latitude && datetime.longitude) {
      facts.push(`- User Location: ${datetime.latitude}, ${datetime.longitude}`);
    }
    return facts.join("\n");
  }

  // Server-side fallback — annotate with server timezone so the LLM
  // knows this may not match the user's local time.
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const dateStr = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: tz }).format(now);

  const timeStr = now.toLocaleTimeString("en-US", {
    hour12: true,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    timeZone: tz,
  });

  return [
    `## Context Facts`,
    `- Current Date: ${dateStr}`,
    `- Current Time: ${timeStr} (${tz})`,
    `- Timestamp: ${now.toISOString()}`,
  ].join("\n");
}

/**
 * Create a system message for temporal grounding.
 * Drop this into your messages array alongside other system messages.
 *
 * @example
 * messages: [
 *   { role: "system", content: systemPrompt },
 *   temporalGroundingMessage(),
 *   { role: "user", content: prompt },
 * ]
 */
export function temporalGroundingMessage(datetime?: DatetimeContext): {
  role: "system";
  content: string;
} {
  return { role: "system", content: buildTemporalFacts(datetime) };
}
