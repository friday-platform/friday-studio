import * as p from "@clack/prompts";

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

  const confirmed = await p.confirm({
    message,
    initialValue: options?.defaultValue ?? false,
  });

  // Handle cancellation
  if (p.isCancel(confirmed)) {
    p.cancel("Operation cancelled");
    return false;
  }

  return confirmed;
}
