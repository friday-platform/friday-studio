/**
 * Byte ceilings for the chat-export route. Pulled out of `+server.ts` so
 * tests can `vi.mock` them with tiny values and exercise the ceiling
 * branches without allocating hundreds of megabytes per test.
 */

/**
 * Per-artifact byte ceiling. Anything larger than this is dropped from the
 * zip with a `console.warn`, reusing the existing single-failure semantics:
 * the entry is omitted, the rest of the export proceeds, the recipient sees
 * one missing download.
 */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024; // 25 MB per artifact

/**
 * Aggregate byte ceiling across every artifact that survives the per-artifact
 * cap. If the running total exceeds this we abort with 413 before the zip is
 * generated rather than streaming a multi-hundred-megabyte response.
 */
export const MAX_TOTAL_ARTIFACT_BYTES = 250 * 1024 * 1024; // 250 MB aggregate
