/**
 * TTS helpers for the playground chat: markdown stripping + sentence-boundary
 * chunking for streaming text. All pure — the speech orchestration (creating
 * `SpeechSynthesisUtterance`, calling `speechSynthesis.speak`) lives in the
 * Svelte component so it can react to `$state` changes and cancel on toggle-off.
 */

/**
 * Strip markdown formatting so the TTS engine doesn't read control
 * characters out loud ("asterisk asterisk bold asterisk asterisk"). Not a
 * full markdown parser — just covers the shapes the chat agent emits.
 *
 * Code fences and inline code are replaced with a short spoken placeholder
 * because raw source read aloud is noise. Tool-use JSON lives in separate
 * `tool-*` parts that we never send to TTS, so this only has to handle the
 * plain-text assistant output.
 */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`[^`\n]+`/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ChunkResult {
  /** Text to hand to speechSynthesis.speak — already stripped. Empty if nothing to say yet. */
  speak: string;
  /** Raw-text offset into the source. Store this and pass back on next call. */
  nextOffset: number;
}

/**
 * Pull the next speakable chunk out of a streaming text buffer.
 *
 * The assistant streams tokens, not sentences. Speaking every token would
 * be jittery and clip mid-word; speaking only at end-of-message defeats
 * the "read along" UX. Compromise: peel off everything up to the last
 * complete sentence boundary in the buffer and speak that, leaving any
 * trailing fragment for the next call.
 *
 * A "sentence boundary" here is `.`, `!`, `?`, or `\n` followed by either
 * whitespace or end-of-string — the same rule most screen readers use.
 * Trailing bare-number lines ("3.") are ignored because the streaming
 * token might be a list marker, not the end of a sentence.
 */
export function nextSpeechChunk(text: string, offset: number): ChunkResult {
  if (offset >= text.length) return { speak: "", nextOffset: offset };

  const tail = text.slice(offset);
  // Two termination rules: a newline always terminates (paragraphs, list
  // items have no trailing punctuation); a `.!?` only terminates when
  // followed by whitespace or end-of-string so that decimals ("3.14") and
  // mid-word punctuation don't split a sentence.
  const boundary = /\n+|[.!?]+(?=\s|$)/g;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(tail)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1) return { speak: "", nextOffset: offset };

  const raw = tail.slice(0, lastEnd);
  const cleaned = stripMarkdownForSpeech(raw);
  return {
    speak: cleaned,
    nextOffset: offset + lastEnd,
  };
}
