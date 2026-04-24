/**
 * Daemon API client for CLI commands
 * All CLI commands should use this to communicate with the daemon
 */

import { getAtlasDaemonUrl } from "@atlas/oapi-client";

export class DaemonClient {
  // =================================================================
  // CONFIG OPERATIONS
  // =================================================================

  /**
   * Get environment variables from ~/.atlas/.env
   */
  async getEnvVars(): Promise<Record<string, string>> {
    const response = await fetch(`${getAtlasDaemonUrl()}/api/config/env`);
    if (!response.ok) {
      throw new Error(`Failed to get env vars: ${response.statusText}`);
    }
    const json = (await response.json()) as {
      success: boolean;
      envVars?: Record<string, string>;
      error?: string;
    };

    if (json.success) {
      return json.envVars || {};
    }

    throw new Error(json.error || "Failed to get env vars");
  }

  /**
   * Write environment variables to ~/.atlas/.env
   */
  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    const response = await fetch(`${getAtlasDaemonUrl()}/api/config/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars }),
    });
    if (!response.ok) {
      throw new Error(`Failed to set env vars: ${response.statusText}`);
    }
    const json = (await response.json()) as { success: boolean; error?: string };

    if (!json.success) {
      throw new Error(json.error || "Failed to set env vars");
    }
  }
}
