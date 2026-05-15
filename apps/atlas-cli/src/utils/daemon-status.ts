import type { client, InferResponseType } from "@atlas/client/v2";
import { infoOutput, successOutput } from "./output.ts";

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && parts.length < 2) parts.push(`${seconds}s`);

  return parts.join(" ") || "0s";
}

export function displayDaemonStatus(
  status: InferResponseType<typeof client.daemon.status.$get>,
  port: number,
): void {
  successOutput(`Atlas daemon is running on port ${port}`);
  infoOutput(`Uptime: ${formatUptime(status.uptime)}`);
  infoOutput(`Active dispatches: ${status.activeWorkspaces}`);

  if (status.activeWorkspaces > 0) {
    infoOutput(`Active workspace IDs: ${status.workspaces.join(", ")}`);
  }

  const memoryMB = Math.round(status.memoryUsage.rss / 1024 / 1024);
  infoOutput(`Memory usage: ${memoryMB} MB`);
}
