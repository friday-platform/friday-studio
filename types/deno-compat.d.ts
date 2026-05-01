/**
 * Ambient type augmentations for Deno-specific APIs that don't exist in DOM typings.
 *
 * svelte-check uses tsc (not Deno's checker), so transitive imports of Deno
 * runtime code surface DOM type errors. These augmentations paper over the
 * two known gaps:
 *
 * 1. `WorkerOptions.deno` -- Deno extends the standard WorkerOptions with a
 *    `deno` property for permission sandboxing. DOM typings don't have it.
 *
 * 2. `ReadableStream[Symbol.asyncIterator]` -- Deno's ReadableStream is async-
 *    iterable, but the DOM ReadableStream interface isn't. This breaks
 *    `for await (const chunk of stream)` under tsc.
 */
/** biome-ignore-all lint/suspicious/noExplicitAny: <needed for interface merging> */

interface WorkerOptions {
  deno?: { permissions: unknown };
}

// Must match DOM's `ReadableStream<R = any>` generic default for interface merging
// deno-lint-ignore no-explicit-any
interface ReadableStream<R = any> {
  [Symbol.asyncIterator](): AsyncIterableIterator<R>;
}
