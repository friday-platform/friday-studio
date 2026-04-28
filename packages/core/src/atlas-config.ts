import process from "node:process";

/**
 * Centralized Atlas configuration utilities
 */

const DEFAULT_FRIDAY_URL = "https://atlas.tempestdx.com";

/**
 * Gets the base Atlas API URL from environment or default
 * Supports both http (local testing) and https (production)
 */
export function getAtlasBaseUrl(): string {
  return process.env.FRIDAY_URL || DEFAULT_FRIDAY_URL;
}

/**
 * Gets the full credentials API endpoint URL
 * K8s pods can override via FRIDAY_CREDENTIALS_URL to point to Cypher directly
 */
export function getCredentialsApiUrl(): string {
  return process.env.FRIDAY_CREDENTIALS_URL || `${getAtlasBaseUrl()}/api/credentials`;
}
