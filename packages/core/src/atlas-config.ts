import process from "node:process";

/**
 * Centralized Atlas configuration utilities
 */

const DEFAULT_ATLAS_URL = "https://atlas.tempestdx.com";

/**
 * Gets the base Atlas API URL from environment or default
 * Supports both http (local testing) and https (production)
 */
export function getAtlasBaseUrl(): string {
  return process.env.ATLAS_URL || DEFAULT_ATLAS_URL;
}

/**
 * Gets the full credentials API endpoint URL
 */
export function getCredentialsApiUrl(): string {
  return `${getAtlasBaseUrl()}/api/credentials`;
}

/**
 * Gets the full diagnostics API endpoint URL
 */
export function getDiagnosticsApiUrl(filename: string): string {
  return `${getAtlasBaseUrl()}/api/diagnostics/${filename}`;
}
