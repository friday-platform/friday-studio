import type { IngestOpts } from "../../memory-adapter.ts";

const MAX_CHARS = 512;
const OVERLAP_CHARS = 64;

export type ChunkerFn = (text: string) => string[];

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

export function SentenceChunker(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g);
  if (!sentences) return [text];

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

export const DefaultChunker = SentenceChunker;

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
