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

const MENTION_REGEX = /@([a-zA-Z0-9_\-:.]+)\/([a-zA-Z0-9_\-:.]+)/g;

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
 * Tracked insertion of a mention in the textarea. `start` is the
 * offset of the leading `@` in `value`; `length` covers the whole
 * inserted display (typically `@Title `, including the trailing
 * space). The composer maintains these offsets across user edits via
 * `applyEditDelta` so two picks with the same title resolve to their
 * correct refs at submit time. See friday-studio-a0q.
 */
export interface InsertedMentionSpan {
  start: number;
  length: number;
  ref: InsertedMentionRef;
}

/**
 * Shift / drop tracked spans in response to a text edit. The textarea's
 * single string offset is the source of truth; we diff old vs new to
 * find the [editStart, prevEnd) → [editStart, newEnd) replacement and:
 *   - spans entirely before the edit: untouched
 *   - spans entirely after the edit:  shift by delta
 *   - spans that overlap the edit:    dropped (their display was
 *     mutilated; the user clearly didn't want them to track)
 */
export function applyEditDelta(
  spans: ReadonlyArray<InsertedMentionSpan>,
  prevValue: string,
  newValue: string,
): InsertedMentionSpan[] {
  if (prevValue === newValue) return [...spans];
  // Common prefix.
  let editStart = 0;
  const minLen = Math.min(prevValue.length, newValue.length);
  while (editStart < minLen && prevValue[editStart] === newValue[editStart]) editStart++;
  // Common suffix.
  let prevEnd = prevValue.length;
  let newEnd = newValue.length;
  while (
    prevEnd > editStart &&
    newEnd > editStart &&
    prevValue[prevEnd - 1] === newValue[newEnd - 1]
  ) {
    prevEnd--;
    newEnd--;
  }
  const delta = newEnd - editStart - (prevEnd - editStart);
  const updated: InsertedMentionSpan[] = [];
  for (const span of spans) {
    const spanEnd = span.start + span.length;
    if (spanEnd <= editStart) {
      updated.push(span);
    } else if (span.start >= prevEnd) {
      updated.push({ ...span, start: span.start + delta });
    }
    // else: edit overlaps the span — drop it.
  }
  return updated;
}

/**
 * Substitute each tracked-span's display text with the canonical
 * `@workspaceId/chatId` token the server resolver expects. Walks
 * spans in reverse offset order so earlier offsets remain valid as
 * later ones splice. Spans whose slice no longer matches the
 * expected display (e.g. the user mutated the inserted text inline)
 * are skipped — the server then sees a literal `@Title` and won't
 * resolve it, which is the safer failure mode.
 */
export function expandMentionSpans(
  text: string,
  spans: ReadonlyArray<InsertedMentionSpan>,
): { text: string; mentions: InsertedMentionRef[] } {
  if (spans.length === 0) return { text, mentions: [] };
  // Splice in reverse offset order so earlier offsets remain valid as
  // later ones change length. Each insertMention emits `@Title ` (with
  // a trailing space) — require exactly that match. applyEditDelta
  // drops any span whose display the user mutated; this slice check
  // is the second-line guard for misses applyEditDelta didn't catch.
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  const useByStart = new Map<number, InsertedMentionRef>();
  for (const span of sorted) {
    const expected = `@${span.ref.title} `;
    if (out.slice(span.start, span.start + span.length) !== expected) continue;
    const canonical = `@${span.ref.workspaceId}/${span.ref.chatId} `;
    out = out.slice(0, span.start) + canonical + out.slice(span.start + span.length);
    useByStart.set(span.start, span.ref);
  }
  // Return refs in original (leftmost-first) order so callers see a
  // stable, source-text-aligned list. Dedupe by canonical key so two
  // mentions of the same chat surface once.
  const used: InsertedMentionRef[] = [];
  const seen = new Set<string>();
  const inOrder = [...useByStart.keys()].sort((a, b) => a - b);
  for (const start of inOrder) {
    const ref = useByStart.get(start);
    if (!ref) continue;
    const key = `${ref.workspaceId}/${ref.chatId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    used.push(ref);
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
