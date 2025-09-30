/**
 * Output utilities for the Atlas CLI
 * Properly separates stdout (data) from stderr (errors, progress, logs)
 */

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
