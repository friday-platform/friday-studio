/**
 * Discriminated union representing the execution lifecycle.
 *
 * Replaces the `executing`/`cancelled`/`activeStream` boolean triple
 * with a single state machine where impossible states are unrepresentable.
 *
 * @example
 * ```ts
 * let execution = $state<ExecutionStatus>({ state: "idle" });
 *
 * // Only the "running" variant carries a stream reference
 * if (execution.state === "running") {
 *   execution.stream.cancel();
 * }
 * ```
 */
export type ExecutionStatus =
  | { state: "idle" }
  | { state: "running"; stream: ReadableStream<Uint8Array> }
  | { state: "cancelled" }
  | { state: "complete" }
  | { state: "error"; message: string };
