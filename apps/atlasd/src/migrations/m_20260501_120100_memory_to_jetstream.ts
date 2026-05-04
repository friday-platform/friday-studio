/**
 * Migration: legacy markdown narrative stores → JetStream stream +
 * MEMORY_INDEX KV bucket.
 *
 * Introduced by commit 7492ae5 ("feat(memory): move narrative storage
 * to JetStream"). Wraps `migrateLegacyMemory()`. Pre-existing migration
 * is idempotent (each narrative checks for an existing MEMORY_INDEX
 * KV entry before re-publishing).
 */

import type { Migration } from "jetstream";
import { migrateLegacyMemory } from "../memory-migration.ts";

export const migration: Migration = {
  id: "20260501_120100_memory_to_jetstream",
  name: "memory-narrative → JetStream",
  description:
    "Walk ~/.atlas/memory/<wsId>/narrative/<name>/ and migrate every legacy " +
    "narrative store (entries.jsonl + MEMORY.md) into a per-(workspace, narrative) " +
    "JetStream stream + the MEMORY_INDEX KV bucket. Skips narratives whose " +
    "MEMORY_INDEX KV entry already exists.",
  async run({ nc, logger }) {
    await migrateLegacyMemory(nc);
    logger.debug("Memory migration body completed");
  },
};
