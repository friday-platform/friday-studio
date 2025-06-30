import type { ConversationMessage, ConversationSession } from "./conversation-supervisor.ts";

export class ConversationSessionManager {
  private sessions: Map<string, ConversationSession> = new Map();
  private messageHistory: Map<string, ConversationMessage[]> = new Map();

  /**
   * Create a new conversation session
   */
  async createSession(
    workspaceId: string,
    userId: string,
    clientType: string = "atlas-cli",
    mode: "private" | "shared" = "private",
  ): Promise<ConversationSession> {
    const sessionId = `conv_${Math.random().toString(36).substring(2, 10)}`;
    const timestamp = new Date().toISOString();

    const session: ConversationSession = {
      id: sessionId,
      workspaceId,
      mode,
      participants: [{
        userId,
        clientType,
        joinedAt: timestamp,
        lastSeen: timestamp,
      }],
      createdAt: timestamp,
      lastActivity: timestamp,
      messageHistory: [],
    };

    this.sessions.set(sessionId, session);
    this.messageHistory.set(sessionId, []);

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): ConversationSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Add message to session history
   */
  addMessage(
    sessionId: string,
    messageId: string,
    fromUser: string,
    content: string,
    type: "user" | "assistant" | "system" = "user",
  ): ConversationMessage {
    const message: ConversationMessage = {
      id: messageId,
      sessionId,
      fromUser,
      content,
      timestamp: new Date().toISOString(),
      type,
    };

    const history = this.messageHistory.get(sessionId) || [];
    history.push(message);
    this.messageHistory.set(sessionId, history);

    // Update session last activity
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = message.timestamp;
      session.messageHistory = history;
    }

    return message;
  }

  /**
   * Get message history for session
   */
  getMessageHistory(sessionId: string): ConversationMessage[] {
    return this.messageHistory.get(sessionId) || [];
  }

  /**
   * Update participant last seen
   */
  updateParticipantActivity(sessionId: string, userId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const participant = session.participants.find((p) => p.userId === userId);
      if (participant) {
        participant.lastSeen = new Date().toISOString();
      }
      session.lastActivity = new Date().toISOString();
    }
  }

  /**
   * Future: Add participant to shared session
   */
  async joinSession(
    sessionId: string,
    userId: string,
    clientType: string = "atlas-cli",
  ): Promise<ConversationSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.mode !== "shared") {
      return null;
    }

    // Check if user is already a participant
    const existingParticipant = session.participants.find((p) => p.userId === userId);
    if (existingParticipant) {
      existingParticipant.lastSeen = new Date().toISOString();
      return session;
    }

    // Add new participant
    const timestamp = new Date().toISOString();
    session.participants.push({
      userId,
      clientType,
      joinedAt: timestamp,
      lastSeen: timestamp,
    });
    session.lastActivity = timestamp;

    return session;
  }

  /**
   * Future: Remove participant from session
   */
  leaveSession(sessionId: string, userId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    session.participants = session.participants.filter((p) => p.userId !== userId);
    session.lastActivity = new Date().toISOString();

    // If no participants left and it's a private session, clean up
    if (session.participants.length === 0 && session.mode === "private") {
      this.sessions.delete(sessionId);
      this.messageHistory.delete(sessionId);
    }

    return true;
  }

  /**
   * Get all sessions for a workspace
   */
  getWorkspaceSessions(workspaceId: string): ConversationSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.workspaceId === workspaceId);
  }

  /**
   * Get all sessions for a user
   */
  getUserSessions(userId: string): ConversationSession[] {
    return Array.from(this.sessions.values()).filter((s) =>
      s.participants.some((p) => p.userId === userId)
    );
  }

  /**
   * Clean up old sessions (for memory management)
   */
  cleanupOldSessions(maxAgeHours: number = 24): number {
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.lastActivity < cutoffTime) {
        this.sessions.delete(sessionId);
        this.messageHistory.delete(sessionId);
        cleanedCount++;
      }
    }

    return cleanedCount;
  }
}
