import { cancel, confirm, isCancel } from "./prompts.tsx";

/**
 * Prompt for confirmation on destructive actions
 * Can be bypassed with --force or --yes flags
 */
export async function confirmAction(
  message: string,
  options?: {
    force?: boolean;
    yes?: boolean;
    defaultValue?: boolean;
  },
): Promise<boolean> {
  // Skip confirmation if force or yes flags are provided
  if (options?.force || options?.yes) {
    return true;
  }

  const confirmed = await confirm({
    message,
    defaultValue: options?.defaultValue ?? false,
  });

  // Handle cancellation
  if (isCancel(confirmed)) {
    cancel("Operation cancelled");
    return false;
  }

  return confirmed as boolean;
}
