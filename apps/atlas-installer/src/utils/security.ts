/**
 * Security utilities for safe command execution
 */

/**
 * Escape PowerShell variables
 */
export function escapePowerShell(str: string): string {
  if (!str) return "";

  return str.replace(/\$/g, "`$").replace(/"/g, '`"').replace(/'/g, "''").replace(/\\/g, "\\\\");
}
