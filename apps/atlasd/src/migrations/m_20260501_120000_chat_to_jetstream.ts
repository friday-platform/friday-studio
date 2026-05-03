/**
 * Migration: legacy file-backed chats → JetStream stream + CHATS KV bucket.
 *
 * Introduced by commit 9c0f0fd ("feat(chat): move chat storage to
 * JetStream"). Wraps the pre-existing `migrateLegacyChats()` body, which
 * was idempotent before this framework existed (each chat checks for an
 * existing CHATS KV entry before re-publishing). Lives behind the
 * migrations runner now so we get a proper audit trail and a single
 * `atlas migrate` entry point.
 */

import type { Migration } from "jetstream";
import { migrateLegacyChats } from "../chat-migration.ts";

export const migration: Migration = {
  id: "20260501_120000_chat_to_jetstream",
  name: "chat-storage → JetStream",
  description:
    "Walk ~/.atlas/chats/ and migrate every legacy chat_*.json into a per-chat " +
    "JetStream stream + the CHATS KV bucket. Skips chats whose KV entry already " +
    "exists. Oversized messages (>8MB) are skipped with a warning rather than " +
    "blocking the chat from migrating.",
  async run({ nc, logger }) {
    await migrateLegacyChats(nc);
    logger.debug("Chat migration body completed");
  },
};
