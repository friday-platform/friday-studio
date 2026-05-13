/**
 * Byte-stability diff helper.
 *
 * Two captured system-prompt snapshots from consecutive turns SHOULD be
 * byte-identical for the cacheable portion (the system prompt is split
 * into stable cache blocks; per-turn variation lives elsewhere). When
 * they differ, the *first* byte position of divergence is the most
 * useful signal — that's where the cache breakpoint stops matching and
 * the rest of the prefix can no longer be served from cache.
 *
 * The helper does NOT try to localize the divergence to a specific
 * cache block — that would require knowing block boundaries, which the
 * caller has but the helper doesn't. It returns the byte offset; the
 * caller (the chat-inspector view) maps that offset to a block label.
 */

export interface ByteStabilityResult {
  /** True iff the two strings are byte-identical. */
  identical: boolean;
  /**
   * Byte offset (0-based) where the strings first differ. `null` when
   * the strings are identical OR when one is empty.
   */
  divergeAt: number | null;
  /**
   * Length difference in bytes. Positive when `next` is longer; negative
   * when shorter; zero on equal-length strings.
   */
  lengthDelta: number;
  /**
   * A short context window around the divergence: 16 bytes before + 16
   * bytes after, with a `|` marker at the divergence point. `null` when
   * identical. Useful for surfacing the actual content shift to the
   * operator without requiring a full diff view.
   */
  excerpt: string | null;
}

const CONTEXT_WINDOW = 16;

/**
 * Compare two strings byte-by-byte and report the first divergence.
 *
 * Strings are compared as JS code units (UTF-16) — close enough to bytes
 * for the operator-facing UI here, where the only consumer is the
 * inspector tile that displays divergence points. For bit-exact byte
 * accounting, the caller should TextEncoder both sides first; today's
 * use-case (system-prompt drift detection) doesn't need that precision.
 */
export function compareBytes(prev: string, next: string): ByteStabilityResult {
  if (prev === next) {
    return { identical: true, divergeAt: null, lengthDelta: 0, excerpt: null };
  }

  const lengthDelta = next.length - prev.length;
  const minLen = Math.min(prev.length, next.length);

  let divergeAt: number | null = null;
  for (let i = 0; i < minLen; i++) {
    if (prev[i] !== next[i]) {
      divergeAt = i;
      break;
    }
  }
  if (divergeAt === null) {
    // One is a strict prefix of the other; the divergence is at the end of
    // the shorter string.
    divergeAt = minLen;
  }

  const start = Math.max(0, divergeAt - CONTEXT_WINDOW);
  const beforeNext = next.slice(start, divergeAt);
  const afterNext = next.slice(divergeAt, divergeAt + CONTEXT_WINDOW);
  const excerpt = `…${beforeNext}|${afterNext}…`;

  return { identical: false, divergeAt, lengthDelta, excerpt };
}
