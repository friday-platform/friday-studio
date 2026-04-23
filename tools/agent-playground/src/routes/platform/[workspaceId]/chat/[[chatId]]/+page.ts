import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Generate a short, URL-friendly chat ID.
 * Format: `chat_` prefix + 10 random alphanumeric chars.
 * The prefix makes the ID self-describing (Stripe-style) so you can
 * eyeball a URL and know it’s a chat. 10 chars gives 62^10 (~8e17)
 * collision space — effectively infinite for a single-user playground.
 */
function generateChatId(): string {
  const randomValues = new Uint8Array(10);
  crypto.getRandomValues(randomValues);
  let result = "chat_";
  for (let i = 0; i < 10; i++) {
    result += CHARS[randomValues[i] % CHARS.length];
  }
  return result;
}

export const load: PageLoad = async ({ params }) => {
  const wsId = params.workspaceId ?? "user";
  const chatId = params.chatId;

  if (!chatId) {
    throw redirect(302, `/platform/${encodeURIComponent(wsId)}/chat/${generateChatId()}`);
  }

  return { chatId };
};
