/**
 * hello-ts: minimal NATS protocol agent for end-to-end registration testing.
 *
 * Uses npm:nats directly so it works from any install path
 * (no monorepo workspace resolution needed).
 */

import process from "node:process";
import { connect, StringCodec } from "npm:nats@^2";

const sc = StringCodec();
const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";

const validateId = process.env.FRIDAY_VALIDATE_ID;
if (validateId) {
  const nc = await connect({ servers: natsUrl });
  nc.publish(
    `agents.validate.${validateId}`,
    sc.encode(
      JSON.stringify({
        id: "hello-ts",
        version: "1.0.0",
        description: "Echo agent for end-to-end NATS registration testing",
      }),
    ),
  );
  await nc.drain();
} else {
  const sessionId = process.env.FRIDAY_SESSION_ID;
  if (sessionId) {
    const nc = await connect({ servers: natsUrl });
    const sub = nc.subscribe(`agents.${sessionId}.execute`);
    // Signal ready after subscribing so the daemon knows to send the execute request.
    nc.publish(`agents.${sessionId}.ready`, sc.encode(""));
    for await (const msg of sub) {
      const raw = JSON.parse(sc.decode(msg.data)) as { prompt?: string };
      const prompt = raw.prompt ?? "";
      const response = { tag: "ok", val: JSON.stringify({ data: `Echo: ${prompt}` }) };
      if (msg.reply) nc.publish(msg.reply, sc.encode(JSON.stringify(response)));
      sub.unsubscribe();
      break;
    }
    await nc.drain();
  }
}
