/**
 * Per-context permissions policy. Used at the workspace level (defaults)
 * and per-job (overrides). Job-level setting wins over workspace-level over
 * the daemon-level `FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS` env var.
 *
 * Today: only the allowlist-bypass flag. Future: elicitation policy
 * (which kinds emit elicitations, default expiry, etc.) lands here.
 */
import { z } from "zod";

export const PermissionsConfigSchema = z.strictObject({
  /**
   * Bypass for tool/skill allowlist enforcement (Phase 1).
   * When `true`, allowlist denials silently pass through with a debug log
   * instead of becoming elicitations or hard failures. Mirrors Claude
   * Code's `--dangerously-skip-permissions` flag — trusted-context-only,
   * never default.
   *
   * Precedence: job > workspace > daemon. Setting this to `false` at a
   * lower level (e.g. job) re-enforces safety even when a higher level
   * has bypassed.
   */
  dangerouslySkipAllowlist: z
    .boolean()
    .optional()
    .describe(
      "Bypass tool/skill allowlist enforcement. Trusted contexts only. " +
        "Job setting overrides workspace setting overrides FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS daemon flag.",
    ),
});

export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;

/**
 * Resolved (effective) permissions at action-execution time.
 *
 * Same shape as PermissionsConfig but every field is concrete (no
 * undefined). Computed by merging job-level over workspace-level over
 * the daemon-level FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS env var.
 */
export interface ResolvedPermissions {
  dangerouslySkipAllowlist: boolean;
}

export interface ResolvePermissionsInput {
  /** Per-job override. Wins over workspace + daemon. */
  job?: PermissionsConfig | undefined;
  /** Workspace-level setting. Wins over daemon. */
  workspace?: PermissionsConfig | undefined;
  /**
   * Daemon-level floor. Pass `process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS === "1"`
   * (or equivalent) at the call site so the helper stays pure.
   */
  daemonDangerouslySkipAllowlist?: boolean;
}

/**
 * Compute effective permissions at action-execution time.
 *
 * Precedence: job > workspace > daemon. Each level can override its
 * parent in either direction (a strict job inside a permissive workspace,
 * or vice versa). Undefined at every level → safe default (false).
 */
export function resolvePermissions(input: ResolvePermissionsInput): ResolvedPermissions {
  const dangerouslySkipAllowlist =
    input.job?.dangerouslySkipAllowlist ??
    input.workspace?.dangerouslySkipAllowlist ??
    input.daemonDangerouslySkipAllowlist ??
    false;
  return { dangerouslySkipAllowlist };
}
