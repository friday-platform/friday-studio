import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const res = await parseResult(client.chat[":chatId"].$get({ param: { chatId: params.chatId } }));

  if (!res.ok) {
    // Chat not found or error - redirect to new chat
    redirect(302, "/");
  }

  return { chatId: res.data.chat.id, messages: await validateAtlasUIMessages(res.data.messages) };
};
