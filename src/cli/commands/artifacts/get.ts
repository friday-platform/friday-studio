import { client, parseResult } from "@atlas/client/v2";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import type { YargsInstance } from "../../utils/yargs.ts";

const ArgsSchema = z.object({
  id: z.string().min(1, "Artifact ID is required"),
  revision: z.coerce.number().int().positive().optional(),
});

export const command = "get <id>";
export const desc = "Get artifact by ID (prints JSON)";

export function builder(y: YargsInstance) {
  return y
    .positional("id", { describe: "Artifact ID", type: "string" })
    .option("revision", {
      alias: "r",
      type: "number",
      describe: "Optional revision number (defaults to latest)",
    })
    .example("$0 artifacts get art_123", "Fetch an artifact by ID")
    .example("$0 artifacts get art_123 --revision 2", "Fetch a specific artifact revision");
}

export async function handler(argv: unknown): Promise<void> {
  const parsed = ArgsSchema.safeParse(argv);
  if (!parsed.success) {
    logger.error(z.prettifyError(parsed.error));
    Deno.exit(1);
  }

  const { id, revision } = parsed.data;

  const res = await parseResult(
    client.artifactsStorage[":id"].$get({
      param: { id },
      query: { revision: revision?.toString() },
    }),
  );

  if (!res.ok) {
    logger.error(`Failed to retrieve artifact: ${stringifyError(res.error)}`);
    Deno.exit(1);
  }

  // Print raw JSON from endpoint
  logger.info(JSON.stringify(res.data.artifact.data, null, 2));
}
