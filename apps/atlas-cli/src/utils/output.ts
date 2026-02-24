/**
 * Output utilities for the Atlas CLI
 *
 * - errorOutput/warningOutput: stderr (actual problems)
 * - infoOutput/successOutput: stdout (status messages)
 *
 * This ensures OTEL correctly marks errors as ERROR and info as INFO.
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
 * Write info/progress messages to stdout
 */
export function infoOutput(message: string): void {
  console.log(message);
}

/**
 * Write success messages to stdout
 */
export function successOutput(message: string): void {
  console.log(`✓ ${message}`);
}
