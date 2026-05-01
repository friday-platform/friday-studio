/**
 * Bridges Friday's callback-based signal API to Chat SDK's iterable-based
 * `thread.post()` by wrapping `triggerSignalWithSession` in a ReadableStream.
 */

/** Signature matching `triggerSignalWithSession` — injected for testability. */
export type TriggerFn = (
  signalName: string,
  payload: Record<string, unknown>,
  streamId: string,
  onStreamEvent: (chunk: unknown) => void,
) => Promise<{ sessionId: string }>;

/**
 * Trigger a workspace signal and stream chunks. `onRawEvent` taps every chunk
 * before it enters the stream — used to fan rich events to StreamRegistry in
 * parallel with text-only consumption via `thread.post`.
 */
export function signalToStream<T = unknown>(
  triggerFn: TriggerFn,
  signalName: string,
  payload: Record<string, unknown>,
  streamId: string,
  onRawEvent?: (chunk: unknown) => void,
): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      triggerFn(signalName, payload, streamId, (chunk: unknown) => {
        onRawEvent?.(chunk);
        try {
          controller.enqueue(chunk as T);
        } catch {
          // Stream cancelled by consumer — chunks still flow to onRawEvent tap
        }
      }).then(
        () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
        (err: unknown) => {
          try {
            controller.error(err);
          } catch {
            /* already errored/closed */
          }
        },
      );
    },
  });
}
