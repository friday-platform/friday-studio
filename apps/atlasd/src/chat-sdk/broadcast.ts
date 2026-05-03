/**
 * Broadcast helper — fans a session's final output to every configured chat
 * communicator's `default_destination`, except the source.
 *
 * NOTE on scope: the underlying ChatSdkNotifier is single-destination
 * (transactional, caller decides where to send). This broadcaster is the
 * routing layer that fans out to every wired communicator.
 */

import { createLogger } from "@atlas/logger";
import type { ChatSdkNotifier, NotifierPostable } from "./chat-sdk-notifier.ts";

const logger = createLogger({ component: "chat-sdk-broadcast" });

export interface BroadcastJobOutputArgs {
  notifier: ChatSdkNotifier;
  /** Map keyed by adapter kind ("slack" | "telegram" | ...) to the platform-native default destination. */
  destinations: Record<string, string>;
  /** Adapter kind that originally triggered the session, or null for non-chat triggers (cron, HTTP). */
  sourceCommunicator: string | null;
  /** The message body to broadcast. */
  output: NotifierPostable;
  /** Workspace ID, for log correlation. */
  workspaceId: string;
}

/**
 * Broadcast a session's final output to every configured chat communicator
 * EXCEPT the one that triggered the inbound signal. Used by the daemon's
 * session-completion hook to relay agent output across platforms (e.g.
 * a Slack-triggered chat reply also lands in the workspace's Telegram DM).
 *
 * Per-platform errors are logged but do not interrupt other broadcasts.
 */
export async function broadcastJobOutput(args: BroadcastJobOutputArgs): Promise<void> {
  const targets = args.notifier.list().filter((entry) => entry.kind !== args.sourceCommunicator);
  if (targets.length === 0) {
    logger.debug("broadcast_no_targets", {
      workspaceId: args.workspaceId,
      sourceCommunicator: args.sourceCommunicator,
    });
    return;
  }

  for (const target of targets) {
    const rawDestination = args.destinations[target.kind];
    if (!rawDestination) {
      logger.debug("broadcast_no_destination", {
        workspaceId: args.workspaceId,
        kind: target.kind,
      });
      continue;
    }
    // Resolve destination shape:
    //   `user:<id>`         → call adapter.openDM(<id>) for a DM threadId
    //   `<kind>:...`        → already a fully-shaped threadId, pass through
    //   anything else       → treat as a channel ID, format into a top-level
    //                          post threadId (`<kind>:<channel>:`)
    let destination: string;
    if (rawDestination.startsWith("user:")) {
      const userId = rawDestination.slice("user:".length);
      try {
        destination = await args.notifier.openDM(target.name, userId);
      } catch (error) {
        logger.warn("broadcast_open_dm_failed", {
          workspaceId: args.workspaceId,
          kind: target.kind,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    } else if (rawDestination.startsWith(`${target.kind}:`)) {
      destination = rawDestination;
    } else {
      destination = `${target.kind}:${rawDestination}:`;
    }
    try {
      const result = await args.notifier.post({
        communicator: target.name,
        destination,
        message: args.output,
      });
      logger.info("broadcast_sent", {
        workspaceId: args.workspaceId,
        kind: target.kind,
        destination,
        messageId: result.messageId,
      });
    } catch (error) {
      logger.warn("broadcast_post_failed", {
        workspaceId: args.workspaceId,
        kind: target.kind,
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
