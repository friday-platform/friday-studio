/**
 * hello-stream-ts: streaming NATS agent that emits text-delta progress events.
 *
 * Demonstrates streaming output visible in the playground's Stream tab.
 * Uses npm:nats directly (portable, no monorepo resolution needed).
 */

import process from "node:process";
import { connect, StringCodec } from "npm:nats@^2";

const sc = StringCodec();
const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
const validateId = process.env.ATLAS_VALIDATE_ID;

if (validateId) {
  const nc = await connect({ servers: natsUrl });
  nc.publish(
    `agents.validate.${validateId}`,
    sc.encode(
      JSON.stringify({
        id: "hello-stream-ts",
        version: "1.0.0",
        description: "Streaming agent example — emits text-delta events visible in the Stream tab",
      }),
    ),
  );
  await nc.drain();
} else {
  const sessionId = process.env.ATLAS_SESSION_ID;
  if (!sessionId) process.exit(1);

  const nc = await connect({ servers: natsUrl });

  const sub = nc.subscribe(`agents.${sessionId}.execute`);
  // Signal ready after subscribing so the daemon knows to send the execute request.
  nc.publish(`agents.${sessionId}.ready`, sc.encode(""));

  for await (const msg of sub) {
    const raw = JSON.parse(sc.decode(msg.data)) as { prompt?: string };
    const prompt = raw.prompt ?? "(no prompt)";

    const words =
      `You said: "${prompt}". I am a streaming agent — each word arrives as a separate delta event.`.split(
        " ",
      );

    for (const word of words) {
      nc.publish(
        `sessions.${sessionId}.events`,
        sc.encode(JSON.stringify({ type: "text-delta", delta: word + " " })),
      );
      await new Promise<void>((r) => setTimeout(r, 80));
    }

    const fullText = words.join(" ").trimEnd();
    const response = { tag: "ok", val: JSON.stringify({ data: fullText }) };
    if (msg.reply) nc.publish(msg.reply, sc.encode(JSON.stringify(response)));
    sub.unsubscribe();
    break;
  }

  await nc.drain();
}
