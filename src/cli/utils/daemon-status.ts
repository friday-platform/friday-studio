import { type AtlasClient, getAtlasClient } from "@atlas/client";
import { infoOutput, successOutput } from "./output.ts";

/**
 * Get a client for local daemon management on a specific port.
 * This is used by daemon management commands (start/stop/status) to manage
 * local daemon instances. It always uses localhost regardless of ATLAS_DAEMON_URL.
 *
 * @param port The port to connect to (defaults to 8080)
 * @param timeout Optional timeout in milliseconds
 * @returns Atlas client configured for local daemon management
 */
export function getLocalDaemonClient(port: number = 8080, timeout?: number): AtlasClient {
  return getAtlasClient({
    url: `http://localhost:${port}`,
    ...(timeout !== undefined && { timeout }),
  });
}

export interface DaemonStatus {
  uptime: number;
  activeWorkspaces: number;
  configuration: { maxConcurrentWorkspaces: number; idleTimeoutMs: number };
  workspaces: string[];
  memoryUsage: { rss: number };
}

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function formatTimeout(ms: number): string {
  const minutes = Math.floor(ms / 1000 / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

export async function fetchDaemonStatus(port: number): Promise<DaemonStatus | null> {
  try {
    const response = await fetch(`http://localhost:${port}/api/daemon/status`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

export function displayDaemonStatus(status: DaemonStatus, port: number): void {
  successOutput(`Atlas daemon is running on port ${port}`);
  infoOutput(`Uptime: ${formatUptime(status.uptime)}`);
  infoOutput(`Active workspaces: ${status.activeWorkspaces}`);
  infoOutput(`Max concurrent workspaces: ${status.configuration.maxConcurrentWorkspaces}`);
  infoOutput(`Idle timeout: ${formatTimeout(status.configuration.idleTimeoutMs)}`);

  if (status.activeWorkspaces > 0) {
    infoOutput(`Active workspace IDs: ${status.workspaces.join(", ")}`);
  }

  const memoryMB = Math.round(status.memoryUsage.rss / 1024 / 1024);
  infoOutput(`Memory usage: ${memoryMB} MB`);
}
