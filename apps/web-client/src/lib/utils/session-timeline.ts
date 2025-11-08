import type {
  SessionHistoryEvent,
  SessionHistoryMetadata,
} from "@atlas/core/session/history-storage";

export interface AgentGroup {
  executionId: string;
  agentId: string;
  events: SessionHistoryEvent[];
  startedAt: string;
  status: "completed" | "error" | "partial" | "in-progress";
}

export interface IndexItem {
  type: "signal" | "agent";
  label: string;
  id: string;
  status: "completed" | "error" | "partial" | "pending" | "in-progress";
  executionId?: string;
}

export interface TimelineData {
  metadata: SessionHistoryMetadata;
  sessionEvents: SessionHistoryEvent[];
  agentGroups: AgentGroup[];
  index: IndexItem[];
}

/**
 * Groups events by agent execution ID
 */
function groupEventsByAgent(events: SessionHistoryEvent[]): AgentGroup[] {
  const groupMap = new Map<string, AgentGroup>();

  for (const event of events) {
    // Skip session-level events
    if (event.type === "session-start" || event.type === "session-finish") {
      continue;
    }

    const executionId = event.context?.executionId;
    if (!executionId) {
      continue;
    }

    let group = groupMap.get(executionId);
    if (!group) {
      // Extract agentId from event data if available
      const agentId =
        ("agentId" in event.data ? (event.data as { agentId?: string }).agentId : undefined) ||
        event.context?.agentId ||
        "unknown";

      group = {
        executionId,
        agentId,
        events: [],
        startedAt: event.emittedAt,
        status: "in-progress",
      };
      groupMap.set(executionId, group);
    }

    group.events.push(event);
  }

  // Determine status for each group
  for (const group of groupMap.values()) {
    const hasError = group.events.some((e) => e.type === "agent-error");
    const hasOutput = group.events.some((e) => e.type === "agent-output");
    const hasValidation = group.events.some((e) => e.type === "validation-result");

    if (hasError) {
      group.status = "error";
    } else if (hasOutput && hasValidation) {
      const validationEvent = group.events.find((e) => e.type === "validation-result");
      if (validationEvent && "verdict" in validationEvent.data) {
        const verdict = (validationEvent.data as { verdict: string }).verdict;
        if (verdict === "pass") {
          group.status = "completed";
        } else if (verdict === "fail") {
          group.status = "error";
        } else {
          group.status = "partial";
        }
      } else {
        group.status = "completed";
      }
    } else if (hasOutput) {
      group.status = "completed";
    } else {
      group.status = "in-progress";
    }
  }

  // Sort by start time
  return Array.from(groupMap.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Builds navigation index from groups
 */
function buildIndex(metadata: SessionHistoryMetadata, agentGroups: AgentGroup[]): IndexItem[] {
  const items: IndexItem[] = [];

  // Add signal item
  items.push({
    type: "signal",
    label: metadata.signal.provider.name,
    id: "signal",
    status:
      metadata.status === "completed"
        ? "completed"
        : metadata.status === "failed"
          ? "error"
          : "pending",
  });

  // Add agent items
  for (const group of agentGroups) {
    items.push({
      type: "agent",
      label: group.agentId,
      id: group.executionId,
      executionId: group.executionId,
      status: group.status,
    });
  }

  return items;
}

/**
 * Transforms raw session data into structured timeline data
 */
export function parseSessionTimeline(
  metadata: SessionHistoryMetadata,
  events: SessionHistoryEvent[],
): TimelineData {
  // Separate session-level events
  const sessionEvents = events.filter(
    (e) => e.type === "session-start" || e.type === "session-finish",
  );

  // Group agent events
  const agentGroups = groupEventsByAgent(events);

  // Build index
  const index = buildIndex(metadata, agentGroups);

  return { metadata, sessionEvents, agentGroups, index };
}
