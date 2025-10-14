import { client, parseResult } from "@atlas/client/v2";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import type { YargsInstance } from "../../utils/yargs.ts";

const ArgsSchema = z
  .object({
    workspace: z.string().optional(),
    chat: z.string().optional(),
    limit: z.coerce.number().int().positive().max(1000).default(100),
  })
  .refine((v) => Boolean(v.workspace || v.chat), {
    message: "Either --workspace or --chat is required",
    path: ["workspace"],
  });

export const command = "list";
export const desc = "List artifacts by workspace or chat (prints JSON)";
export const aliases = ["ls"];

export function builder(y: YargsInstance) {
  return y
    .option("workspace", { type: "string", describe: "Filter by workspace" })
    .option("chat", { type: "string", describe: "Filter by chat" })
    .option("limit", { alias: "l", type: "number", describe: "Max results (1-1000)", default: 100 })
    .example("$0 artifacts list --workspace ws_123", "List artifacts for a workspace")
    .example("$0 artifacts list --chat chat_123", "List artifacts for a chat");
}

export async function handler(argv: unknown): Promise<void> {
  const parsed = ArgsSchema.safeParse(argv);
  if (!parsed.success) {
    logger.error(z.prettifyError(parsed.error));
    Deno.exit(1);
  }

  const { workspace, chat, limit } = parsed.data;

  const res = await parseResult(
    client.artifactsStorage.index.$get({
      query: { workspaceId: workspace, chatId: chat, limit: limit?.toString() },
    }),
  );

  if (!res.ok) {
    logger.error(`Failed to list artifacts: ${stringifyError(res.error)}`);
    Deno.exit(1);
  }

  // Print raw JSON from endpoint directly, following get.ts pattern
  logger.info(JSON.stringify(res.data, null, 2));
}
