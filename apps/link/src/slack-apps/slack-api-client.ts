/** Shared Slack API client for manifest and OAuth operations. */

import { stringifyError } from "@atlas/utils";
import type { z } from "zod";
import { AppInstallError } from "../app-install/errors.ts";

/**
 * Calls a Slack API endpoint with bearer auth and JSON body.
 * @throws AppInstallError on network, HTTP, or parse failure
 */
export async function callSlackApi<T>(
  url: string,
  token: string,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AppInstallError(
      "SLACK_NETWORK_ERROR",
      `${label}: network error: ${stringifyError(err)}`,
    );
  }

  if (!resp.ok) {
    throw new AppInstallError("SLACK_API_ERROR", `${label}: HTTP ${resp.status}`);
  }

  const raw: unknown = await resp.json().catch(() => {
    throw new AppInstallError("SLACK_API_ERROR", `${label}: invalid JSON`);
  });

  return schema.parse(raw);
}
