/**
 * Report issue route — sends an issue report email via SendGrid gateway.
 */

import process from "node:process";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const reportSchema = z.object({ userId: z.string(), chatId: z.string(), sessionId: z.string() });

const reportRoutes = daemonFactory
  .createApp()
  .post("/", zValidator("json", reportSchema), async (c) => {
    const { userId, chatId, sessionId } = c.req.valid("json");

    const gatewayUrl = process.env.FRIDAY_GATEWAY_URL;
    const atlasKey = process.env.FRIDAY_KEY;

    if (!gatewayUrl || !atlasKey) {
      return c.json({ error: "Email gateway not configured" }, 503);
    }

    try {
      const response = await fetch(`${gatewayUrl}/v1/sendgrid/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${atlasKey}` },
        body: JSON.stringify({
          // `from` defaults to notifications@hellofriday.ai in the SendGrid gateway
          to: "support@hellofriday.ai",
          subject: "Chat Issue Report",
          content: [`user_id: ${userId}`, `chat_id: ${chatId}`, `session_id: ${sessionId}`].join(
            "\n",
          ),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error("SendGrid gateway error", { status: response.status, error });
        return c.json({ error: "Failed to send report" }, 502);
      }

      return c.json({ success: true }, 200);
    } catch (error) {
      logger.error("Failed to send report email", { error: stringifyError(error) });
      return c.json({ error: "Failed to send report" }, 500);
    }
  });

export default reportRoutes;
export type ReportRoutes = typeof reportRoutes;
