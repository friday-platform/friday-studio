/**
 * Helpers for parsing and rendering `@workspaceId/chatId` mentions in
 * chat message bodies. Shared by the composer (insertion / autocomplete)
 * and the history view (link rendering).
 *
 * Server-side resolver lives in
 * `apps/atlasd/src/chat-sdk/mention-resolver.ts`. The regex here MUST
 * stay in sync with the server's MENTION_RE so what the UI inserts is
 * what the server expands.
 */

export const MENTION_REGEX = /@([a-zA-Z0-9_\-:.]+)\/([a-zA-Z0-9_\-:.]+)/g;

export interface MentionRef {
  workspaceId: string;
  chatId: string;
}

/** Resolved-mention metadata persisted on a message's `data-mention-resolved` parts. */
export interface ResolvedMentionData {
  workspaceId: string;
  chatId: string;
  title: string;
  snapshot: string;
  messageCount: number;
  generatedAt: string;
}

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; workspaceId: string; chatId: string; title: string; href: string };

/**
 * Split a message-text string into alternating text and mention segments.
 * Mentions are looked up against `resolved` to pull a human-friendly title;
 * unresolved mentions render as plain text so a typo or expired ref doesn't
 * become a broken link.
 */
export function splitMentions(
  text: string,
  resolved: ResolvedMentionData[] = [],
): MentionSegment[] {
  const titleByKey = new Map<string, string>();
  for (const r of resolved) {
    titleByKey.set(`${r.workspaceId}/${r.chatId}`, r.title);
  }

  const segments: MentionSegment[] = [];
  let cursor = 0;
  // matchAll iterates non-overlapping global matches in source order.
  for (const match of text.matchAll(MENTION_REGEX)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, start) });
    }
    const workspaceId = match[1] ?? "";
    const chatId = match[2] ?? "";
    const key = `${workspaceId}/${chatId}`;
    const title = titleByKey.get(key);
    if (title) {
      segments.push({
        kind: "mention",
        workspaceId,
        chatId,
        title,
        // Playground chat URL pattern is `/platform/<workspaceId>/chat/<chatId>`.
        // The earlier `/workspaces/...` form was wrong — that path doesn't exist
        // in this SvelteKit app and produced a 404 on click.
        href: `/platform/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(chatId)}`,
      });
    } else {
      // No resolved metadata — keep the raw @ws/chat token as text.
      segments.push({ kind: "text", text: match[0] });
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  if (segments.length === 0) {
    segments.push({ kind: "text", text });
  }
  return segments;
}

/** Count raw `@ws/chat` tokens in a free-text string (deduped per pair). */
export function countMentionTokens(text: string): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_REGEX)) {
    seen.add(`${m[1]}/${m[2]}`);
  }
  return seen.size;
}

/**
 * Detect an active `@` query at the caret. Returns `null` when the caret
 * isn't inside a mention being typed. Used to drive the composer
 * autocomplete popover.
 *
 * A query starts at the last `@` before the caret and ends at the caret
 * itself, provided:
 *   - the char immediately before the `@` is either start-of-string or
 *     whitespace (avoids matching email-like `name@host`)
 *   - the substring between `@` and caret contains no whitespace, no
 *     `/`, and no character outside the safe mention charset
 */
export function detectActiveMentionQuery(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  if (caret < 1 || caret > text.length) return null;
  const segment = text.slice(0, caret);
  const atIndex = segment.lastIndexOf("@");
  if (atIndex < 0) return null;
  const prevChar = atIndex === 0 ? "" : segment[atIndex - 1];
  if (prevChar && !/\s/.test(prevChar)) return null;
  const query = segment.slice(atIndex + 1);
  if (!/^[a-zA-Z0-9_\-:.]*$/.test(query)) return null;
  return { start: atIndex, end: caret, query };
}

/**
 * What the composer carries forward from each autocomplete-picked
 * mention: the workspace + chat ids the server resolver expects, plus
 * the friendly title we showed in the textarea.
 */
export interface InsertedMentionRef {
  workspaceId: string;
  chatId: string;
  title: string;
}

/**
 * Expand `@Title` occurrences (the human-readable form the composer
 * shows in the textarea) back into the canonical `@workspaceId/chatId`
 * the server resolver expects. The `refsByTitle` map is built up as
 * the user picks entries from the autocomplete. Titles that have been
 * edited or deleted in the textarea won't match and pass through as
 * plain text — the server's resolver will simply find no @ws/chat
 * token for them, which is the safer failure mode.
 */
export function expandMentionDisplayText(
  text: string,
  refsByTitle: ReadonlyMap<string, InsertedMentionRef>,
): { text: string; mentions: InsertedMentionRef[] } {
  if (refsByTitle.size === 0) return { text, mentions: [] };
  let out = text;
  const used: InsertedMentionRef[] = [];
  const seen = new Set<string>();
  // Longest titles first so that "Foo bar" matches before "Foo" — a
  // prefix-title would otherwise eat its own suffix.
  const titles = [...refsByTitle.keys()].sort((a, b) => b.length - a.length);
  for (const title of titles) {
    const ref = refsByTitle.get(title);
    if (!ref) continue;
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // `@<title>` bounded by end-of-string or a non-identifier char so
    // we don't snip into a token the user is still typing (e.g. `@Demos`
    // shouldn't substitute on `@Demo`).
    const re = new RegExp(`@${escaped}(?=$|[\\s.,!?;:)\\]'"])`, "g");
    if (!re.test(out)) continue;
    out = out.replace(re, `@${ref.workspaceId}/${ref.chatId}`);
    const key = `${ref.workspaceId}/${ref.chatId}`;
    if (!seen.has(key)) {
      seen.add(key);
      used.push(ref);
    }
  }
  return { text: out, mentions: used };
}

/**
 * Score a chat title against a free-text query. Returns -Infinity for a
 * non-match. Higher is better. Matches the established lightweight fuzzy
 * heuristics: exact prefix > word-start > contained > none.
 */
export function scoreTitleMatch(title: string, query: string): number {
  if (!query) return 0;
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  if (t.startsWith(q)) return 1000 - (t.length - q.length);
  // Word-start match — any token in the title begins with the query.
  const tokens = t.split(/\s+/);
  for (const token of tokens) {
    if (token.startsWith(q)) return 500 - (token.length - q.length);
  }
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx;
  return Number.NEGATIVE_INFINITY;
}
