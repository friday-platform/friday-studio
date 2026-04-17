/**
 * Pure step-reducer for the chat input queue.
 *
 * While the assistant is streaming we buffer outbound messages in a FIFO
 * instead of blocking the user's typing. The consumer (see the drain loop
 * in `user-chat.svelte`) polls this reducer each tick to decide "can I
 * dequeue and send right now?" — and crucially, the reducer is pure so the
 * branch conditions (empty queue / no Chat instance / already streaming)
 * are unit-testable without mocking `@ai-sdk/svelte`.
 *
 * Extracting this was the C3 fix-forward from the 2026-04-16 review: the
 * racy inline-effect version dispatched before `chat.status` flipped to
 * "submitted" on the microtask, occasionally sending the same queued entry
 * twice. Pinning dequeue behind a pure predicate — plus a single async
 * `flushing` flag in the caller — collapses that surface area.
 *
 * @module
 */

/**
 * Decision returned by {@link nextQueueStep}.
 *
 * - `toSend`: the head of the queue to dispatch next, or `null` when the
 *   caller should wait (queue empty, no Chat instance, or already streaming).
 * - `remainder`: the queue after popping `toSend`. When `toSend` is `null`
 *   this is a defensive copy of the input (so the caller can assign it
 *   without aliasing the input).
 */
export interface QueueStep<T> {
  toSend: T | null;
  remainder: T[];
}

/**
 * Runtime flags the reducer checks before releasing the head of the queue.
 * Kept as a small object so adding future gates (e.g. connectivity,
 * per-workspace freeze) doesn't change every call site.
 */
export interface QueueFlags {
  /** AI SDK Chat status is "submitted" or "streaming". */
  streaming: boolean;
  /** A Chat instance exists — queue can't drain without one. */
  hasChat: boolean;
}

/**
 * Compute the next drain step. Pure: given the same inputs, always returns
 * a `remainder` that is a fresh array (no aliasing) and a `toSend` that is
 * either the head of `queue` or `null`.
 *
 * Never call this from within a reactive `$effect` without a guard against
 * re-entry — this reducer is stateless, but the consumer's `sendMessage`
 * flips `streaming` asynchronously, so two back-to-back effects firing
 * before the status update lands would both see `streaming: false` and
 * both dequeue the same head.
 */
export function nextQueueStep<T>(queue: readonly T[], flags: QueueFlags): QueueStep<T> {
  if (queue.length === 0 || !flags.hasChat || flags.streaming) {
    return { toSend: null, remainder: queue.slice() };
  }
  // Head exists because length > 0; narrow with an explicit branch to stay
  // within noUncheckedIndexedAccess without `as` casts.
  const head = queue[0];
  if (head === undefined) {
    return { toSend: null, remainder: queue.slice() };
  }
  return { toSend: head, remainder: queue.slice(1) };
}
