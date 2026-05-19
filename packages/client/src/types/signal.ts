/**
 * Signal-related type definitions
 *
 * `SignalTriggerResponse` was deleted here in pass-4 fix #1 — the canonical
 * type now lives in `@atlas/core/signal-trigger-response.ts` so atlasd
 * (producer) and every consumer (mcp-server, atlas-cli, workspace-chat
 * job-tools, run-job-dialog, and this @atlas/client SDK) share one
 * source of truth. Import via `import type { SignalTriggerResponse }
 * from "@atlas/core"`.
 */

export interface SignalResponse {
  success: boolean;
  message?: string;
  sessionId?: string;
  error?: string;
}
