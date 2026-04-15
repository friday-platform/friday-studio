/**
 * Client-side module for the /schedule slash command.
 *
 * Parses the command, calls the daemon's schedule-expand route to
 * expand NL into a structured task brief, and builds the correctly-shaped
 * backlog entry for POSTing to the narrative memory API.
 *
 * @module
 */

import { z } from "zod";
import type { ScheduleProposal } from "../components/chat/types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SCHEDULE_PREFIX = "/schedule ";
const SCHEDULE_EXPAND_URL = "/api/daemon/api/schedule-expand";
const BACKLOG_URL = "/api/daemon/api/memory/poached_quiche/narrative/autopilot-backlog";
const DEFAULT_AUTHOR = "lcf";
const TARGET_WORKSPACE_ID = "fizzy_waffle";
const SIGNAL_ID = "run-task" as const;

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const ScheduleProposalSchema = z.object({
  taskId: z.string(),
  text: z.string().max(120),
  taskBrief: z.string(),
  priority: z.number().int().min(5).max(20),
  kind: z.enum(["feature", "improvement", "bugfix"]),
});

export const BacklogEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string(),
  metadata: z.object({
    status: z.literal("pending"),
    priority: z.number().int(),
    kind: z.string(),
    blocked_by: z.array(z.string()),
    payload: z.object({
      workspace_id: z.string(),
      signal_id: z.literal("run-task"),
      task_id: z.string(),
      task_brief: z.string(),
    }),
  }),
});

export type BacklogEntry = z.infer<typeof BacklogEntrySchema>;

// ─── Command parsing ─────────────────────────────────────────────────────────

export interface ParsedScheduleCommand {
  input: string;
}

/**
 * Detect and parse a /schedule command from user input.
 * Returns the NL input text if matched, or null for non-schedule messages.
 */
export function parseScheduleCommand(text: string): ParsedScheduleCommand | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(SCHEDULE_PREFIX)) {
    return null;
  }
  const input = trimmed.slice(SCHEDULE_PREFIX.length).trim();
  if (input.length === 0) {
    return null;
  }
  return { input };
}

// ─── LLM expansion ───────────────────────────────────────────────────────────

/**
 * Call the daemon's schedule-expand route to expand NL into a ScheduleProposal.
 * Throws on network or validation errors.
 */
export async function expandScheduleInput(input: string): Promise<ScheduleProposal> {
  const response = await fetch(SCHEDULE_EXPAND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`Schedule expand failed (${response.status}): ${errorText}`);
  }

  const json: unknown = await response.json();
  return ScheduleProposalSchema.parse(json);
}

// ─── Backlog entry construction ───────────────────────────────────────────────

/**
 * Build a correctly-shaped backlog entry from a ScheduleProposal.
 * Matches the shape expected by the FAST Loop planner.
 */
export function buildBacklogEntry(proposal: ScheduleProposal): BacklogEntry {
  return {
    id: proposal.taskId,
    text: proposal.text,
    author: DEFAULT_AUTHOR,
    metadata: {
      status: "pending",
      priority: proposal.priority,
      kind: proposal.kind,
      blocked_by: [],
      payload: {
        workspace_id: TARGET_WORKSPACE_ID,
        signal_id: SIGNAL_ID,
        task_id: proposal.taskId,
        task_brief: proposal.taskBrief,
      },
    },
  };
}

// ─── Backlog submission ───────────────────────────────────────────────────────

export interface ScheduleResult {
  ok: boolean;
  taskId: string;
  priority: number;
  error?: string;
}

/**
 * POST a confirmed backlog entry to the narrative memory API.
 */
export async function submitBacklogEntry(entry: BacklogEntry): Promise<ScheduleResult> {
  const response = await fetch(BACKLOG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    return {
      ok: false,
      taskId: entry.id,
      priority: entry.metadata.priority,
      error: `POST failed (${response.status}): ${errorText}`,
    };
  }

  return {
    ok: true,
    taskId: entry.id,
    priority: entry.metadata.priority,
  };
}
