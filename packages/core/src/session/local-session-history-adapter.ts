/**
 * Local filesystem implementation of SessionHistoryAdapter.
 *
 * Storage layout:
 *   {baseDir}/{sessionId}/events.jsonl  — append-only event log
 *   {baseDir}/{sessionId}/metadata.json — pre-computed SessionSummary
 *
 * Events are stored as JSONL (one JSON object per line) for crash recovery.
 * Corrupted lines are skipped with a warning on read.
 *
 * @module
 */

import { access, appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@atlas/logger";
import type { SessionStreamEvent, SessionSummary, SessionView } from "./session-events.ts";
import { SessionStreamEventSchema, SessionSummarySchema } from "./session-events.ts";
import type { SessionHistoryAdapter } from "./session-history-adapter.ts";
import { buildSessionView } from "./session-reducer.ts";

const logger = createLogger({ component: "local-session-history-adapter" });

/**
 * Local filesystem adapter for session history v2.
 * Uses JSONL for incremental event appends and JSON for finalized summaries.
 */
export class LocalSessionHistoryAdapter implements SessionHistoryAdapter {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Append a single event as a JSONL line. Creates session directory on demand. */
  async appendEvent(sessionId: string, event: SessionStreamEvent): Promise<void> {
    const sessionDir = join(this.baseDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const eventsPath = join(sessionDir, "events.jsonl");
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
  }

  /** Write events.jsonl and metadata.json for a finalized session. */
  async save(
    sessionId: string,
    events: SessionStreamEvent[],
    summary: SessionSummary,
  ): Promise<void> {
    const sessionDir = join(this.baseDir, sessionId);
    await mkdir(sessionDir, { recursive: true });

    const eventsContent = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await writeFile(join(sessionDir, "events.jsonl"), eventsContent, "utf-8");
    await writeFile(join(sessionDir, "metadata.json"), JSON.stringify(summary, null, 2), "utf-8");
  }

  /** Read JSONL events and reduce to SessionView. Returns null if not found. */
  async get(sessionId: string): Promise<SessionView | null> {
    const eventsPath = join(this.baseDir, sessionId, "events.jsonl");

    let content: string;
    try {
      content = await readFile(eventsPath, "utf-8");
    } catch {
      return null;
    }

    const events: SessionStreamEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = SessionStreamEventSchema.parse(JSON.parse(line));
        events.push(parsed);
      } catch (err) {
        logger.warn("Skipping corrupted JSONL line", { sessionId, error: String(err) });
      }
    }

    return buildSessionView(events);
  }

  /** Read metadata.json files, optionally filter by workspaceId, return sorted summaries. */
  async listByWorkspace(workspaceId?: string): Promise<SessionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];

    for (const entry of entries) {
      const metadataPath = join(this.baseDir, entry, "metadata.json");
      try {
        const content = await readFile(metadataPath, "utf-8");
        const summary = SessionSummarySchema.parse(JSON.parse(content));
        if (!workspaceId || summary.workspaceId === workspaceId) {
          summaries.push(summary);
        }
      } catch {
        // No metadata.json or invalid — skip
      }
    }

    summaries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return summaries;
  }

  /**
   * Walk session dirs that have events.jsonl but no metadata.json — these
   * are sessions whose daemon process died mid-flight. Reduce their events
   * into a partial SessionSummary and write metadata.json with status
   * "interrupted" so the listing endpoint surfaces them as failed-to-finish
   * rather than "still active forever".
   */
  async markInterruptedSessions(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return 0;
    }

    let count = 0;
    for (const entry of entries) {
      const sessionDir = join(this.baseDir, entry);
      const eventsPath = join(sessionDir, "events.jsonl");
      const metadataPath = join(sessionDir, "metadata.json");

      try {
        await access(eventsPath);
      } catch {
        continue;
      }
      try {
        await access(metadataPath);
        continue;
      } catch {
        // No metadata.json — this session was mid-flight.
      }

      try {
        const content = await readFile(eventsPath, "utf-8");
        const events: SessionStreamEvent[] = [];
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            events.push(SessionStreamEventSchema.parse(JSON.parse(line)));
          } catch {
            // Skip corrupted lines
          }
        }
        if (events.length === 0) continue;

        const view = buildSessionView(events);
        const summary: SessionSummary = {
          sessionId: entry,
          workspaceId: view.workspaceId,
          jobName: view.jobName,
          task: view.task,
          status: "interrupted",
          startedAt: view.startedAt,
          completedAt: new Date().toISOString(),
          stepCount: view.agentBlocks.length,
          agentNames: view.agentBlocks.map((b) => b.agentName),
          error: "Daemon was killed mid-session",
        };
        await writeFile(metadataPath, JSON.stringify(summary, null, 2), "utf-8");
        count++;
      } catch (err) {
        logger.warn("Failed to mark session interrupted", { sessionId: entry, error: String(err) });
      }
    }

    if (count > 0) {
      logger.info("Marked sessions as interrupted on startup", { count });
    }
    return count;
  }
}
