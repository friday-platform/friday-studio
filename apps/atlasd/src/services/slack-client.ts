import { createLogger } from "@atlas/logger";

const logger = createLogger({ component: "slack-client" });

interface PostSlackMessageParams {
  token: string;
  channel: string;
  text: string;
  threadTs?: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

/**
 * Posts message to Slack via chat.postMessage API.
 * @throws Error if Slack API returns ok: false
 */
export async function postSlackMessage(params: PostSlackMessageParams): Promise<void> {
  const { token, channel, text, threadTs } = params;

  const body: Record<string, string> = { channel, text };
  if (threadTs) {
    body.thread_ts = threadTs;
  }

  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as SlackApiResponse;

  if (!data.ok) {
    logger.error("slack_api_error", { error: data.error, channel });
    throw new Error(`Slack API error: ${data.error}`);
  }

  logger.debug("slack_message_posted", { channel, hasThread: !!threadTs });
}
