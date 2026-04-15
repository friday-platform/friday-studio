/**
 * Deprecated backward-compatible re-exports.
 *
 * These aliases let existing eval code (`@atlas/bundled-agents` imports) keep
 * compiling while Task #18 migrates evals to the unified web agent. Remove
 * this file once eval migration is complete.
 *
 * @deprecated Use `webAgent` and `WebOutputSchema` directly.
 */

import { type WebAgentResult, WebOutputSchema, webAgent } from "./index.ts";

/**
 * @deprecated Use `WebOutputSchema` instead. The old browser agent returned
 * `{ summary }` but the unified web agent returns `{ response }`.
 */
export const BrowserOutputSchema = WebOutputSchema;

/** @deprecated Use `WebAgentResult` instead. */
export type BrowserAgentResult = WebAgentResult;

/**
 * @deprecated Use `webAgent` instead. This is the old browser agent — now
 * backed by the unified web agent. Output shape has changed from `{ summary }`
 * to `{ response }`.
 */
export const browserAgent = webAgent;

/**
 * @deprecated Use `WebOutputSchema` instead. Output shape is identical
 * (`{ response }`).
 */
export const ResearchOutputSchema = WebOutputSchema;

/**
 * @deprecated Use `webAgent` instead. This is the old web search agent — now
 * backed by the unified web agent.
 */
export const webSearchAgent = webAgent;
