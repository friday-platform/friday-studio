import React from "react";
import { Text } from "ink";
import { LogViewer } from "../components/LogViewer.tsx";

export interface LogsCommandProps {
  sessionId?: string;
  flags: any;
}

export function LogsCommand({ sessionId, flags }: LogsCommandProps) {
  if (!sessionId) {
    return (
      <Text color="red">
        Session ID required. Usage: atlas logs &lt;session-id&gt;
      </Text>
    );
  }

  return (
    <LogViewer
      sessionId={sessionId}
      follow={flags.follow !== false} // Default to true
      tail={flags.tail || 100}
      filter={{
        agent: flags.agent,
        level: flags.level,
      }}
    />
  );
}
