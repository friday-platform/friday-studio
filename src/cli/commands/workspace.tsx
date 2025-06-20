import { Text } from "ink";
import {
  WorkspaceInitCommand,
  WorkspaceServeCommand,
  WorkspaceListCommand,
  WorkspaceStatusCommand,
  WorkspaceRemoveCommand,
  WorkspaceCleanupCommand,
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
  // Route to the appropriate subcommand component
  switch (subcommand) {
    case "init":
      return <WorkspaceInitCommand args={args} flags={flags} />;

    case "serve":
      return <WorkspaceServeCommand args={args} flags={flags} />;

    case "list":
      return <WorkspaceListCommand args={args} flags={flags} />;

    case "status":
      return <WorkspaceStatusCommand args={args} flags={flags} />;

    case "remove":
      return <WorkspaceRemoveCommand args={args} flags={flags} />;

    case "cleanup":
      return <WorkspaceCleanupCommand args={args} flags={flags} />;

    default:
      // Default to serve if no subcommand provided
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
