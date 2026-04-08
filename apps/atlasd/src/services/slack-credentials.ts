import { z } from "zod";

/** Shape of the Link service response for `GET /internal/v1/slack-apps/by-workspace/:id`. */
export const ByWorkspaceResponseSchema = z.object({
  credential_id: z.string(),
  app_id: z.string(),
});

/** Shape of a slack-app credential secret as stored by Link. */
export const SlackCredentialSecretSchema = z.object({
  access_token: z.string(),
  signing_secret: z.string().optional(),
});
