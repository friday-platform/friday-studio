/**
 * Stripe-style short chat id: `chat_` prefix + 10 random alphanumeric chars.
 * 62^10 (~8e17) collision space — effectively infinite for our scale.
 *
 * Safe to import from both browser and server runtimes; relies only on
 * `crypto.getRandomValues`, available in both.
 */

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateChatId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let result = "chat_";
  for (const byte of bytes) {
    result += CHARS[byte % CHARS.length];
  }
  return result;
}
