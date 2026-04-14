import type { IngestOpts } from "../../memory-adapter.ts";

const MAX_TOKENS = 512;
const OVERLAP_TOKENS = 64;

type ChunkerFn = (text: string) => string[];

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

export function DefaultChunker(text: string): string[] {
  const words = tokenize(text);
  if (words.length <= MAX_TOKENS) return [text];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < words.length) {
    const end = Math.min(pos + MAX_TOKENS, words.length);
    chunks.push(words.slice(pos, end).join(" "));
    if (end >= words.length) break;
    pos = end - OVERLAP_TOKENS;
  }

  return chunks;
}

export const ChunkerRegistry = new Map<string, ChunkerFn>();

export function getChunker(opts?: IngestOpts): ChunkerFn {
  if (opts?.chunker !== undefined) {
    const registered = ChunkerRegistry.get(opts.chunker);
    if (registered) return registered;
  }
  return DefaultChunker;
}
