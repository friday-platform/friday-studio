import { randomColor } from "@atlas/utils";
import { loadChat } from "$lib/modules/conversation/load-chat";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const result = await loadChat(params.chatId, "/chat");

  if (result.isNew) {
    return { ...result, color: randomColor() };
  }

  const { chat, ...data } = result;
  return { ...data, color: chat.color };
};
