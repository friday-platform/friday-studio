import { client, parseResult } from "@atlas/client/v2";
import  {type  Color, ColorSchema } from "@atlas/utils";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async ({ params }) => {
  const res = await parseResult(client.me.index.$get());
  const user = res.ok && res.data.success ? res.data.user : null;

  // Fetch color based on route params
  let color: Color | undefined;

  if (params.chatId) {
    const chatRes = await parseResult(
      client.chat[":chatId"].$get({ param: { chatId: params.chatId } }),
    );
    if (chatRes.ok) {
      color = ColorSchema.parse(chatRes.data.chat.color);
    }
  } else if (params.spaceId) {
    const spaceRes = await parseResult(
      client.workspace[":workspaceId"].$get({ param: { workspaceId: params.spaceId } }),
    );
    if (spaceRes.ok) {
      color = ColorSchema.parse(spaceRes.data.metadata?.color);
    }
  }

  return { user, color };
};
