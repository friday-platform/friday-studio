/**
 * Bridges the FSM engine's `notification` action to the chat-SDK broadcast
 * path. The engine sees an `FSMBroadcastNotifier` (a dependency-inversion seam
 * — fsm-engine is a leaf package and can't import atlasd's `ChatSdkInstance`
 * directly) and calls `broadcast({ message, communicators? })`; this adapter
 * resolves the workspace's `ChatSdkInstance` lazily and delegates to
 * `broadcastJobOutput` with `sourceCommunicator: null`. (FSM jobs are not
 * chat-platform sources today, so there's no echo-skip — if FSMs ever start
 * being invoked from a chat context that wants suppression, this is the spot
 * to thread the source through.)
 *
 * `communicators` is treated as a strict allowlist: every requested kind must
 * resolve to a configured destination, otherwise the call throws. This fails
 * loud on typos like `["slak"]` instead of silently dropping the request.
 * Per-platform delivery errors (network flakes, rate limits) are still
 * swallowed inside `broadcastJobOutput` — this adapter only throws on
 * configuration errors.
 */

import type { FSMBroadcastNotifier } from "@atlas/fsm-engine";
import { broadcastJobOutput } from "./broadcast.ts";
import type { ChatSdkInstance } from "./chat-sdk-instance.ts";

export interface FSMBroadcastAdapterDeps {
  workspaceId: string;
  getInstance: (workspaceId: string) => Promise<ChatSdkInstance>;
}

export function createFSMBroadcastNotifier(deps: FSMBroadcastAdapterDeps): FSMBroadcastNotifier {
  return {
    async broadcast({ message, communicators }) {
      const instance = await deps.getInstance(deps.workspaceId);
      const allDestinations = instance.broadcastDestinations;
      const configured = Object.keys(allDestinations);

      let destinations: Record<string, string>;
      if (communicators) {
        const missing = communicators.filter((kind) => !(kind in allDestinations));
        if (missing.length > 0) {
          throw new Error(
            `Notification requested communicators=[${communicators.join(", ")}] ` +
              `but [${missing.join(", ")}] have no default_destination configured. ` +
              `Configured: [${configured.join(", ") || "none"}].`,
          );
        }
        destinations = Object.fromEntries(
          Object.entries(allDestinations).filter(([kind]) => communicators.includes(kind)),
        );
      } else {
        if (configured.length === 0) {
          throw new Error(
            "Notification has no deliverable destinations. " +
              "Workspace has no chat communicators with a default_destination configured.",
          );
        }
        destinations = allDestinations;
      }

      await broadcastJobOutput({
        workspaceId: deps.workspaceId,
        notifier: instance.notifier,
        destinations,
        sourceCommunicator: null,
        output: { markdown: message },
      });
    },
  };
}
