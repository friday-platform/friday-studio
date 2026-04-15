import { describe, expect, it } from "vitest";
import {
  BacklogEntrySchema,
  buildBacklogEntry,
  parseScheduleCommand,
} from "./fast-task-scheduler.ts";
import type { ScheduleProposal } from "../components/chat/types.ts";

describe("parseScheduleCommand", () => {
  it("returns parsed input for a valid /schedule command", () => {
    const result = parseScheduleCommand("/schedule fix the foo");
    expect(result).toEqual({ input: "fix the foo" });
  });

  it("is case-insensitive on the prefix", () => {
    const result = parseScheduleCommand("/Schedule Fix the bar");
    expect(result).toEqual({ input: "Fix the bar" });
  });

  it("trims whitespace from the input", () => {
    const result = parseScheduleCommand("  /schedule   add a new feature  ");
    expect(result).toEqual({ input: "add a new feature" });
  });

  it("returns null for a non-schedule message", () => {
    expect(parseScheduleCommand("hello")).toBeNull();
  });

  it("returns null for empty schedule input", () => {
    expect(parseScheduleCommand("/schedule ")).toBeNull();
    expect(parseScheduleCommand("/schedule")).toBeNull();
  });

  it("returns null for messages that start with /schedulex (not a space after)", () => {
    expect(parseScheduleCommand("/schedulex something")).toBeNull();
  });
});

describe("buildBacklogEntry", () => {
  const proposal: ScheduleProposal = {
    taskId: "manual-fix-broken-foo-a1b2c3d4",
    text: "Fix the broken foo widget",
    taskBrief: "The foo widget is throwing errors when clicked. Debug and fix the root cause.",
    priority: 10,
    kind: "bugfix",
  };

  it("produces a correctly-shaped backlog entry", () => {
    const entry = buildBacklogEntry(proposal);

    expect(entry.id).toBe("manual-fix-broken-foo-a1b2c3d4");
    expect(entry.text).toBe("Fix the broken foo widget");
    expect(entry.author).toBe("lcf");
    expect(entry.metadata.status).toBe("pending");
    expect(entry.metadata.priority).toBe(10);
    expect(entry.metadata.kind).toBe("bugfix");
    expect(entry.metadata.blocked_by).toEqual([]);
    expect(entry.metadata.payload.workspace_id).toBe("fizzy_waffle");
    expect(entry.metadata.payload.signal_id).toBe("run-task");
    expect(entry.metadata.payload.task_id).toBe("manual-fix-broken-foo-a1b2c3d4");
    expect(entry.metadata.payload.task_brief).toBe(
      "The foo widget is throwing errors when clicked. Debug and fix the root cause.",
    );
  });

  it("validates against BacklogEntrySchema", () => {
    const entry = buildBacklogEntry(proposal);
    const result = BacklogEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("uses the proposal taskId as both id and payload.task_id", () => {
    const entry = buildBacklogEntry(proposal);
    expect(entry.id).toBe(entry.metadata.payload.task_id);
  });
});
