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
