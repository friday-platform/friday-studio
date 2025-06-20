import { Text } from "ink";
import {
  WorkspaceCleanupCommand,
  WorkspaceInitCommand,
  WorkspaceListCommand,
  WorkspaceLogsCommand,
  WorkspaceRemoveCommand,
  WorkspaceRestartCommand,
  WorkspaceServeCommand,
  WorkspaceStatusCommand,
  WorkspaceStopCommand,
} from "./workspace/index.ts";

export interface WorkspaceCommandProps {
  subcommand?: string;
  args: string[];
  flags: Record<string, unknown>;
}

export function WorkspaceCommand({
  subcommand,
  args,
  flags,
}: WorkspaceCommandProps) {
  switch (subcommand) {
    case "init":
      return <WorkspaceInitCommand args={args} flags={flags} />;

    case "start":
    case "serve":
      return <WorkspaceServeCommand args={args} flags={flags} />;

    case "list":
    case "ls":
      return <WorkspaceListCommand args={args} flags={flags} />;

    case "status":
      return <WorkspaceStatusCommand args={args} flags={flags} />;

    case "stop":
      return <WorkspaceStopCommand args={args} flags={flags} />;

    case "restart":
      return <WorkspaceRestartCommand args={args} flags={flags} />;

    case "remove":
    case "rm":
      return <WorkspaceRemoveCommand args={args} flags={flags} />;

    case "cleanup":
      return <WorkspaceCleanupCommand args={args} flags={flags} />;

    case "logs":
      return <WorkspaceLogsCommand args={args} flags={flags} />;

    default:
      if (!subcommand) {
        return <WorkspaceServeCommand args={args} flags={flags} />;
      } else {
        return <Text color="red">Unknown workspace command: {subcommand}</Text>;
      }
  }
}

// Re-export shared utilities and components for backward compatibility
export { getWorkspaceStatus } from "./workspace/utils.ts";
export { WorkspaceList } from "./workspace/list.tsx";
export { WorkspaceStatusDisplay as WorkspaceStatus } from "./workspace/status.tsx";
