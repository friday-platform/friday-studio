import type { z } from "zod";

/**
 * Extract JSON object substrings containing an "operation" key using
 * balanced-brace matching with string boundary tracking. Unlike a regex
 * with `[^{}]`, this handles nested objects (findings arrays, thread_replies).
 */
function extractJsonCandidates(text: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let end = i;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (inString) {
        if (ch === "\\") {
          end++;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0 && !inString) {
      const candidate = text.slice(i, end + 1);
      if (candidate.includes('"operation"')) {
        results.push(candidate);
      }
      i = end;
    }
  }
  return results;
}

/**
 * Parse the operation config from the prompt string.
 *
 * Searches for JSON blocks in code fences, raw JSON objects, or the entire
 * prompt as JSON. Generic over the Zod schema so all agents (bb, gh, jira)
 * can share this logic.
 *
 * When multiple matches exist (e.g. an FSM step's prompt accumulates
 * envelopes from prior steps as `### Document:` sections), prefer the
 * LAST matching candidate. Workspace prompts append documents in order,
 * so the most recent — the one this step is meant to act on — appears
 * latest in the prompt. Returning the first match would dispatch on a
 * stale upstream envelope.
 */
export function parseOperationConfig<T extends z.ZodType>(prompt: string, schema: T): z.infer<T> {
  let lastMatch: z.infer<T> | undefined;

  // Try JSON code fences
  const jsonBlockPattern = /```json\s*([\s\S]*?)```/g;
  for (const blockMatch of prompt.matchAll(jsonBlockPattern)) {
    const jsonContent = blockMatch[1];
    if (!jsonContent) continue;
    try {
      const parsed: unknown = JSON.parse(jsonContent);
      const result = schema.safeParse(parsed);
      if (result.success) lastMatch = result.data;
    } catch {
      // Not valid JSON, continue
    }
  }
  if (lastMatch !== undefined) return lastMatch;

  // Try raw JSON objects containing "operation" key
  for (const candidate of extractJsonCandidates(prompt)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const result = schema.safeParse(parsed);
      if (result.success) lastMatch = result.data;
    } catch {
      // Not valid JSON, continue
    }
  }
  if (lastMatch !== undefined) return lastMatch;

  // Last resort: parse the entire prompt as JSON
  try {
    const parsed: unknown = JSON.parse(prompt);
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Not valid JSON
  }

  throw new Error(
    `Could not parse operation config from prompt. Expected JSON with "operation" field. Prompt starts with: ${prompt.slice(0, 200)}`,
  );
}
