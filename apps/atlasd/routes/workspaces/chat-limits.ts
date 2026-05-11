/**
 * Limits for `GET /:chatId?full=true` — the export-preview path that
 * bypasses the live UI's last-100 trim. Lifted out of `chat.ts` so tests
 * can `vi.mock` them with tiny values and exercise the cap branches
 * without allocating tens of megabytes per assertion.
 *
 * The trimmed view (`?full` absent) doesn't need either limit: it is
 * bounded at 100 messages and the daemon can serialise that comfortably.
 */

/**
 * Maximum number of messages returned by `?full=true`. Walking every
 * message through `validateAtlasUIMessages` is unbounded HTML-sanitise
 * work — the cap rejects with 413 before the validator runs.
 *
 * 5000 was picked as a heuristic ceiling: roughly two orders of magnitude
 * beyond a long power-user session, well below where the daemon starts
 * paging, and large enough that no real user has hit it. Revisit if real
 * exports start landing 413s.
 */
export const MAX_FULL_EXPORT_MESSAGES = 5000;

/**
 * Maximum byte length of the serialised JSON body returned by
 * `?full=true`. The message-count cap bounds validator walk time but says
 * nothing about per-message size — a chat with four messages each
 * carrying a 200 MB tool output passes the count check, fully loads into
 * RAM, gets sanitised, JSON-stringified, and shipped over the wire. Cap
 * the serialised payload so a single oversized tool output can't pin the
 * daemon or the orchestrator.
 *
 * 50 MB is a soft headroom over the largest legitimate exports observed
 * (chats with hundreds of small tool calls cluster well under 5 MB)
 * while staying small enough that holding two copies during
 * stringify+send is comfortable.
 */
export const MAX_FULL_EXPORT_BYTES = 50 * 1024 * 1024;
