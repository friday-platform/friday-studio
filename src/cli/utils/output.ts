/**
 * Output utilities for the Atlas CLI
 * Properly separates stdout (data) from stderr (errors, progress, logs)
 */

interface OutputOptions {
  json?: boolean;
  noColor?: boolean;
}

/**
 * Write data output to stdout
 * This should be used for primary command output that can be piped
 */
export function dataOutput(data: unknown, options?: OutputOptions): void {
  if (options?.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

/**
 * Write error messages to stderr
 */
export function errorOutput(message: string): void {
  console.error(`Error: ${message}`);
}

/**
 * Write warning messages to stderr
 */
export function warningOutput(message: string): void {
  console.error(`Warning: ${message}`);
}

/**
 * Write info/progress messages to stderr
 */
export function infoOutput(message: string): void {
  console.error(message);
}

/**
 * Write success messages to stderr
 */
export function successOutput(message: string): void {
  console.error(`✓ ${message}`);
}

/**
 * Check if output is being piped
 */
export function isPiped(): boolean {
  return !Deno.stdout.isTerminal();
}

/**
 * Check if NO_COLOR environment variable is set
 */
export function shouldDisableColor(): boolean {
  return Deno.env.get("NO_COLOR") !== undefined ||
    Deno.env.get("ATLAS_NO_COLOR") !== undefined;
}
