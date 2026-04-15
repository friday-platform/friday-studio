/**
 * Normalize loose message inputs into a `unknown[]` suitable for
 * `validateAtlasUIMessages`.
 *
 * Accepts:
 * - plain string → wraps as a single user UIMessage with text part
 * - single UIMessage object → wraps in an array
 * - UIMessage array → returns as-is
 * - anything else → wraps in array and lets validateAtlasUIMessages reject it
 */
export function normalizeToUIMessages(message: unknown): unknown[] {
  if (typeof message === "string") {
    return [{ role: "user", id: crypto.randomUUID(), parts: [{ type: "text", text: message }] }];
  }

  if (Array.isArray(message)) {
    return message;
  }

  if (typeof message === "object" && message !== null) {
    return [message];
  }

  // Let validateAtlasUIMessages produce a proper validation error
  return [message];
}
