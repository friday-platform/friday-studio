/**
 * Read-only JetStream + KV inspection for a chat. Mounted as a sibling
 * to `workspaceChatRoutes` rather than chained on it because adding a
 * fifth-or-later handler to that chain pushes Hono's response-type
 * inference past TS's instantiation-depth limit (TS2589). Keeping this
 * surface in its own tiny app keeps both chains short.
 *
 * Path under daemon mount: GET /api/workspaces/:workspaceId/chat/:chatId/_debug
 */

import { Hono } from "hono";
import type { AppVariables } from "../../src/factory.ts";

type StreamDebug = {
  name: string;
  subject: string;
  exists: boolean;
  messages?: number;
  bytes?: number;
  firstSeq?: number;
  lastSeq?: number;
  created?: string;
  lastTs?: string;
  retention?: string;
  storage?: string;
  maxMsgSize?: number;
  replicas?: number;
  error?: string;
};

type KvDebug = {
  bucket: string;
  key: string;
  exists: boolean;
  revision?: number;
  created?: string;
  operation?: string;
  length?: number;
  value?: unknown;
  error?: string;
};

/**
 * Stream/subject/bucket conventions mirror
 * `packages/core/src/chat/jetstream-backend.ts`. Kept in sync manually —
 * importing the private helpers from there would expand that module's
 * public surface for a debug-only consumer.
 */
// Plain Hono<AppVariables> instead of the daemonFactory chain. The factory's
// chained inference, when added to the daemon's already-deep `.route()`
// accumulation, trips TS2589. This route doesn't need typed RPC inference
// from the playground — it's hit via raw fetch — so erasing the chain type
// is safe and unblocks the type checker.
const workspaceChatDebugRoutes: Hono<AppVariables> = new Hono<AppVariables>().get(
  "/:chatId/_debug",
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");
    if (!chatId || !workspaceId) {
      return c.json({ error: "Missing workspaceId or chatId" }, 400);
    }
    const ctx = c.get("app");

    const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
    const streamName = `CHAT_${sanitize(workspaceId)}_${sanitize(chatId)}`;
    const subject = `chats.${workspaceId}.${chatId}.messages`;
    const kvBucket = "CHATS";
    const kvKey = `${workspaceId}/${chatId}`;

    let nc: ReturnType<typeof ctx.daemon.getNatsConnection>;
    try {
      nc = ctx.daemon.getNatsConnection();
    } catch {
      return c.json({ error: "NATS not initialized" }, 503);
    }

    let stream: StreamDebug = { name: streamName, subject, exists: false };
    try {
      const jsm = await nc.jetstreamManager();
      const info = await jsm.streams.info(streamName);
      stream = {
        name: streamName,
        subject,
        exists: true,
        messages: info.state.messages as unknown as number,
        bytes: info.state.bytes as unknown as number,
        firstSeq: info.state.first_seq as unknown as number,
        lastSeq: info.state.last_seq as unknown as number,
        created: info.created,
        lastTs: info.state.last_ts,
        retention: String(info.config.retention),
        storage: String(info.config.storage),
        maxMsgSize: info.config.max_msg_size,
        replicas: info.config.num_replicas,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "stream not found" is the common case for a never-used chat —
      // render exists=false so the UI can distinguish "no stream yet"
      // from "NATS broken."
      if (!/not found|no stream/i.test(msg)) {
        stream.error = msg;
      }
    }

    let kv: KvDebug = { bucket: kvBucket, key: kvKey, exists: false };
    try {
      const js = nc.jetstream();
      const k = await js.views.kv(kvBucket);
      const entry = await k.get(kvKey);
      if (entry) {
        const bytes = entry.value;
        let value: unknown = null;
        try {
          value = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          value = `<${bytes.length} bytes, not JSON>`;
        }
        kv = {
          bucket: kvBucket,
          key: kvKey,
          exists: true,
          revision: entry.revision as unknown as number,
          created:
            entry.created instanceof Date ? entry.created.toISOString() : String(entry.created),
          operation: entry.operation,
          length: bytes.length,
          value,
        };
      }
    } catch (err) {
      kv.error = err instanceof Error ? err.message : String(err);
    }

    return c.json({ stream, kv });
  },
);

export default workspaceChatDebugRoutes;
