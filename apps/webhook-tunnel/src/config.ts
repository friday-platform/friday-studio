/**
 * Webhook tunnel configuration — validated via Zod.
 *
 * When WEBHOOK_SECRET is not set, a diceware-style passphrase is
 * auto-generated so webhook signature verification is always enabled.
 */

import process from "node:process";
import { z } from "zod";
import { generatePassphrase } from "./passphrase.ts";

const ConfigSchema = z.object({
  atlasdUrl: z.string().default("http://localhost:8080"),
  webhookSecret: z.string(),
  port: z.coerce.number().default(9090),
  tunnelToken: z.string().optional(),
  noTunnel: z.preprocess((v) => v === "true", z.boolean().default(false)),
});

export type Config = z.infer<typeof ConfigSchema>;

export function readConfig(): Config {
  return ConfigSchema.parse({
    atlasdUrl: process.env.ATLASD_URL,
    webhookSecret: process.env.WEBHOOK_SECRET ?? generatePassphrase(),
    port: process.env.TUNNEL_PORT,
    tunnelToken: process.env.TUNNEL_TOKEN,
    noTunnel: process.env.NO_TUNNEL,
  });
}
