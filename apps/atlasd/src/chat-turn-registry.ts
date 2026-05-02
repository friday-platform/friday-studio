/**
 * Per-chat AbortController registry. When the user sends a new chat message
 * while a previous turn is still streaming, the prior turn's controller is
 * aborted so the in-flight FSM/model call stops and the new message's turn
 * runs alone. Without this, two assistant turns ran concurrently in the same
 * chat — both produced artifacts, both finished, both got persisted.
 *
 * The controller is owned by atlasd (not the inbound HTTP request) because
 * `chat.processMessage` is fire-and-forget: the request that initiated a turn
 * may be long gone by the time the FSM is still working. A request-scoped
 * `request.signal` would abort on client disconnect, not on user follow-up.
 */
import { createLogger } from "@atlas/logger";

const logger = createLogger({ component: "chat-turn-registry" });

export class ChatTurnRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /**
   * Replace the controller for a chatId. Aborts the prior controller (if any)
   * with a structured reason so downstream `AbortSignal.aborted`/`.reason`
   * checks can distinguish "user sent a new message" from generic abort.
   * Returns the fresh controller to attach to the new turn.
   */
  replace(chatId: string): AbortController {
    const existing = this.controllers.get(chatId);
    if (existing && !existing.signal.aborted) {
      existing.abort(new ChatTurnSupersededError(chatId));
      logger.debug("Aborted prior turn on follow-up message", { chatId });
    }
    const next = new AbortController();
    this.controllers.set(chatId, next);
    return next;
  }

  /** Read the live controller for a chatId (or undefined if none). */
  get(chatId: string): AbortController | undefined {
    return this.controllers.get(chatId);
  }

  /**
   * Abort + remove the controller for a chatId. Used by the explicit
   * `DELETE /:chatId/stream` cancel path.
   */
  abort(chatId: string, reason?: unknown): boolean {
    const existing = this.controllers.get(chatId);
    if (!existing) return false;
    if (!existing.signal.aborted) {
      existing.abort(reason ?? new ChatTurnCancelledError(chatId));
    }
    this.controllers.delete(chatId);
    return true;
  }

  /**
   * Drop the entry for a chatId without aborting. Called by the turn's own
   * completion path so we don't accumulate finished controllers. Identity
   * check guards against a race where a follow-up POST already replaced the
   * entry — only delete if it's still ours.
   */
  release(chatId: string, controller: AbortController): void {
    const current = this.controllers.get(chatId);
    if (current === controller) {
      this.controllers.delete(chatId);
    }
  }

  /** Clear all controllers (workspace teardown / daemon shutdown). */
  shutdown(): void {
    for (const controller of this.controllers.values()) {
      if (!controller.signal.aborted) controller.abort(new ChatTurnShutdownError());
    }
    this.controllers.clear();
  }
}

export class ChatTurnSupersededError extends Error {
  readonly chatId: string;
  constructor(chatId: string) {
    super(`Chat turn superseded by a newer message in chat ${chatId}`);
    this.name = "ChatTurnSupersededError";
    this.chatId = chatId;
  }
}

export class ChatTurnCancelledError extends Error {
  readonly chatId: string;
  constructor(chatId: string) {
    super(`Chat turn cancelled by client in chat ${chatId}`);
    this.name = "ChatTurnCancelledError";
    this.chatId = chatId;
  }
}

export class ChatTurnShutdownError extends Error {
  constructor() {
    super("Chat turn cancelled by daemon shutdown");
    this.name = "ChatTurnShutdownError";
  }
}
