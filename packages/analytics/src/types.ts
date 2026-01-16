/**
 * Analytics event types
 */
export interface AnalyticsEvent {
  eventName: string;
  userId: string;
  workspaceId?: string;
  sessionId?: string;
  conversationId?: string;
  jobName?: string;
  attributes?: Record<string, unknown>;
}

export interface AnalyticsClient {
  emit(event: AnalyticsEvent): void;
  shutdown(): Promise<void>;
}

export const EventNames = {
  USER_SIGNED_UP: "user.signed_up",
  USER_PROFILE_COMPLETED: "user.profile_completed",
  USER_LOGGED_IN: "user.logged_in",
  CONVERSATION_STARTED: "conversation.started",
  WORKSPACE_CREATED: "workspace.created",
  JOB_DEFINED: "job.defined",
  SESSION_STARTED: "session.started",
  SESSION_COMPLETED: "session.completed",
  SESSION_FAILED: "session.failed",
} as const;
