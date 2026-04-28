import type { IngestOpts } from "../../memory-adapter.ts";

const MAX_CHARS = 512;
const OVERLAP_CHARS = 64;

export type ChunkerFn = (text: string) => string[];

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

export function SentenceChunker(text: string): string[] {
  // Linear single-pass split: walk to a sentence terminator, then absorb
  // any trailing whitespace before starting the next chunk. The previous
  // regex (`[^.!?]+[.!?]+\s*`) backtracked quadratically on terminator-less
  // input with many spaces.
  const sentences: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?") {
      while (i < text.length && (text[i] === "." || text[i] === "!" || text[i] === "?")) i++;
      while (i < text.length && /\s/.test(text[i] ?? "")) i++;
      if (i > start) sentences.push(text.slice(start, i));
      start = i;
    } else {
      i++;
    }
  }
  if (start < text.length) {
    const tail = text.slice(start);
    if (tail.trim().length > 0) sentences.push(tail);
  }
  if (sentences.length === 0) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > MAX_CHARS && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

export function FixedChunker(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const words = tokenize(text);
  const chunks: string[] = [];
  let pos = 0;

  while (pos < words.length) {
    const end = Math.min(pos + MAX_CHARS, words.length);
    chunks.push(words.slice(pos, end).join(" "));
    if (end >= words.length) break;
    pos = end - OVERLAP_CHARS;
  }

  return chunks;
}

export function NoneChunker(text: string): string[] {
  return [text];
}

const DefaultChunker = SentenceChunker;

export const ChunkerRegistry = new Map<string, ChunkerFn>([
  ["sentence", SentenceChunker],
  ["fixed", FixedChunker],
  ["none", NoneChunker],
]);

export function getChunker(opts?: IngestOpts): ChunkerFn {
  if (opts?.chunker !== undefined) {
    const registered = ChunkerRegistry.get(opts.chunker);
    if (registered) return registered;
  }
  return DefaultChunker;
}
