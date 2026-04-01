/**
 * Reranker using Groq Llama 4 Scout as a cross-encoder.
 * Scores each candidate 0-10 against the query, returns top N.
 *
 * Prompt follows Llama 4 best practices:
 * - System/user role separation via messages array
 * - Explicit "respond in JSON" in prompt text + schema via generateObject
 * - XML tags for structured sections
 * - Few-shot example for output format
 */
import process from "node:process";
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";
import type { SearchResult } from "./search.ts";

const RerankResponseSchema = z.object({
  rankings: z.array(z.object({ index: z.number().int().min(0), score: z.number().min(0).max(10) })),
});

export interface RerankResult {
  results: SearchResult[];
  error?: string;
}

/**
 * Apply source-type diversity: ensure KB/confluence articles are included in the
 * top N when they exist in the candidate pool, even if tickets scored higher.
 */
export function applyDiversity(
  sorted: SearchResult[],
  topN: number,
  kbMinSlots = 2,
): SearchResult[] {
  const kbInTop = sorted.slice(0, topN).filter((r) => r.sourceType !== "ticket");
  if (kbInTop.length >= kbMinSlots) {
    return sorted.slice(0, topN);
  }

  const topKb = sorted.filter((r) => r.sourceType !== "ticket").slice(0, kbMinSlots);
  const ticketSlots = topN - topKb.length;
  const topTickets = sorted.filter((r) => r.sourceType === "ticket").slice(0, ticketSlots);
  return [...topKb, ...topTickets].sort((a, b) => b.score - a.score);
}

/** Escape text for safe inclusion in LLM prompts (prevents prompt injection via query). */
export function escapeForPrompt(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Rerank candidates using Groq Llama 4 Scout.
 * Sends truncated candidates to the LLM, gets relevance scores,
 * returns top N sorted by score with source-type diversity.
 */
export async function rerank(
  query: string,
  candidates: SearchResult[],
  topN = 5,
  env?: Record<string, string>,
): Promise<RerankResult> {
  if (candidates.length <= topN) return { results: candidates };

  const apiKey = env?.GROQ_API_KEY ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      results: applyDiversity(candidates, topN),
      error: "no GROQ_API_KEY, skipped reranker",
    };
  }

  const groq = createGroq({ apiKey });

  const candidateXml = candidates
    .map(
      (c, i) =>
        `<doc index="${i}" type="${escapeForPrompt(c.sourceType)}">${escapeForPrompt(c.title)}: ${escapeForPrompt(c.content.slice(0, 200))}</doc>`,
    )
    .join("\n");

  try {
    const { object } = await generateObject({
      model: groq("meta-llama/llama-4-scout-17b-16e-instruct"),
      schema: RerankResponseSchema,
      messages: [
        {
          role: "system",
          content:
            "You are a relevance scorer. Given a query and documents, rate each document 0-10. " +
            "knowledge_base and confluence documents get a +2 bonus when they address the query topic. " +
            "Respond in JSON with a rankings array.",
        },
        {
          role: "user",
          content: `<query>${escapeForPrompt(query)}</query>

<documents>
${candidateXml}
</documents>

Score every document's relevance to the query (0 = irrelevant, 10 = perfect match).

Example output: {"rankings": [{"index": 0, "score": 8}, {"index": 1, "score": 3}]}`,
        },
      ],
      temperature: 0,
    });

    const sorted = object.rankings
      .sort((a, b) => b.score - a.score)
      .map((r) => {
        const candidate = candidates[r.index];
        if (!candidate) return null;
        return { ...candidate, score: r.score / 10 };
      })
      .filter((r): r is SearchResult => r !== null);

    return { results: applyDiversity(sorted, topN) };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { results: applyDiversity(candidates, topN), error: `Groq reranker failed: ${msg}` };
  }
}
