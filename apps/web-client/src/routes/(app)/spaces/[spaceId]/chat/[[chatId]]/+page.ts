import { loadChat } from "$lib/modules/conversation/load-chat";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const result = await loadChat(params.chatId, `/spaces/${params.spaceId}/chat`);

  if (result.isNew) return result;

  const { chat: _, ...data } = result;
  return data;
};
