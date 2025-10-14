/**
 * Vercel AI SDK helpers for Atlas agents
 *
 * Provides utilities to reduce boilerplate when using the Vercel AI SDK
 * with Atlas agents.
 */

export { pipeUIMessageStream } from "./stream-mapper.ts";
export {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "./tool-usage.ts";
