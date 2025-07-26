import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { SSEDebugClient, SSEDebugEvent } from "../../utils/sse-debug-client.ts";
import { DaemonClient } from "../../utils/daemon-client.ts";
import { YargsInstance } from "../../utils/yargs.ts";
import { getAtlasDaemonUrl } from "@atlas/tools";

interface MonitorState {
  status: "connecting" | "monitoring" | "error" | "stopped";
  sessionId?: string;
  eventCount: number;
  lastEvent?: SSEDebugEvent;
  error?: string;
  startTime: number;
}

const MonitorUI = ({ state }: { state: MonitorState }) => {
  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const formatEventType = (type: string) => {
    const typeColors: Record<string, string> = {
      message_chunk: "blue",
      tool_call: "yellow",
      tool_result: "green",
      thinking: "magenta",
      error: "red",
      message_complete: "cyan",
    };
    return typeColors[type] || "white";
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="white">
          SSE Event Monitor
        </Text>
        {state.sessionId && <Text dimColor>- Session: {state.sessionId.slice(0, 8)}...</Text>}
      </Box>

      <Box flexDirection="row" gap={2} marginBottom={1}>
        <Box>
          <Text>Status:</Text>
          {state.status === "connecting" && (
            <Text color="yellow">
              <Spinner label="Connecting" />
            </Text>
          )}
          {state.status === "monitoring" && <Text color="green">● Monitoring</Text>}
          {state.status === "error" && <Text color="red">✗ Error</Text>}
          {state.status === "stopped" && <Text color="gray">■ Stopped</Text>}
        </Box>

        <Box>
          <Text>Events:</Text>
          <Text color="cyan">{state.eventCount}</Text>
        </Box>

        <Box>
          <Text>Duration:</Text>
          <Text color="cyan">{formatDuration(Date.now() - state.startTime)}</Text>
        </Box>
      </Box>

      {state.error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {state.error}</Text>
        </Box>
      )}

      {state.lastEvent && (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={formatEventType(state.lastEvent.parsed.type)} bold>
              [{state.lastEvent.parsed.type}]
            </Text>
            <Text dimColor>
              #{state.lastEvent.sequenceNumber} • {state.lastEvent.debug.size} bytes •{" "}
              {state.lastEvent.debug.processingTime}ms
            </Text>
          </Box>

          {state.lastEvent.parsed.type === "message_chunk" && (
            <Text>
              {typeof state.lastEvent.parsed.data === "object" &&
                  state.lastEvent.parsed.data &&
                  "content" in state.lastEvent.parsed.data
                ? String((state.lastEvent.parsed.data as any).content).slice(0, 80) +
                  (String((state.lastEvent.parsed.data as any).content).length > 80 ? "..." : "")
                : ""}
            </Text>
          )}

          {state.lastEvent.parsed.type === "tool_call" && (
            <Text>
              {typeof state.lastEvent.parsed.data === "object" &&
                  state.lastEvent.parsed.data &&
                  "toolName" in state.lastEvent.parsed.data
                ? `Tool: ${(state.lastEvent.parsed.data as any).toolName}`
                : ""}
            </Text>
          )}

          {state.lastEvent.debug.error && (
            <Text color="red">Error: {state.lastEvent.debug.error}</Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Press Ctrl+C to stop monitoring</Text>
      </Box>
    </Box>
  );
};

const MonitorApp = ({
  client,
  options,
}: {
  client: SSEDebugClient;
  options: any;
}) => {
  const [state, setState] = useState<MonitorState>({
    status: "connecting",
    eventCount: 0,
    startTime: Date.now(),
  });
  const abortController = useRef<AbortController>(new AbortController());

  useEffect(() => {
    let isMounted = true;

    const startMonitoring = async () => {
      try {
        const iterator = await client.startMonitoring({
          createNewSession: !options.sessionId,
          sessionId: options.sessionId,
          abortSignal: abortController.current.signal,
        });

        if (isMounted) {
          setState((prev) => ({ ...prev, status: "monitoring" }));
        }

        for await (const event of iterator) {
          if (!isMounted) break;

          setState((prev) => ({
            ...prev,
            sessionId: event.streamId,
            eventCount: prev.eventCount + 1,
            lastEvent: event,
          }));
        }
      } catch (error) {
        if (isMounted) {
          setState((prev) => ({
            ...prev,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    };

    startMonitoring();

    return () => {
      isMounted = false;
      abortController.current.abort();
    };
  }, [client, options]);

  // Handle cleanup on unmount
  useEffect(() => {
    const handleExit = () => {
      abortController.current.abort();
      setState((prev) => ({ ...prev, status: "stopped" }));
    };

    // Handle cleanup on unmount
    // In Deno, we use Deno.addSignalListener instead of process.on
    const sigintListener = () => handleExit();
    const sigtermListener = () => handleExit();

    try {
      Deno.addSignalListener("SIGINT", sigintListener);
      Deno.addSignalListener("SIGTERM", sigtermListener);
    } catch {
      // Signal listeners may not be available in all environments
    }

    return () => {
      try {
        Deno.removeSignalListener("SIGINT", sigintListener);
        Deno.removeSignalListener("SIGTERM", sigtermListener);
      } catch {
        // Ignore errors during cleanup
      }
    };
  }, []);

  return <MonitorUI state={state} />;
};

export const command = "monitor";
export const desc = "Monitor SSE events in real-time";

export function builder(y: YargsInstance) {
  return y
    .option("session-id", {
      alias: "s",
      describe: "Connect to existing session ID",
      type: "string",
    })
    .option("output", {
      alias: "o",
      describe: "Output log file path",
      type: "string",
    })
    .option("format", {
      alias: "f",
      describe: "Output format: json, jsonl, pretty",
      type: "string",
      default: "jsonl",
    })
    .option("filter", {
      describe: "Filter event types (comma-separated)",
      type: "string",
    })
    .option("verbose", {
      alias: "v",
      describe: "Verbose output",
      type: "boolean",
    })
    .option("workspace", {
      alias: "w",
      describe: "Workspace ID",
      type: "string",
      default: "default",
    })
    .option("daemon", {
      alias: "d",
      describe: "Daemon URL",
      type: "string",
      default: getAtlasDaemonUrl(),
    });
}

export const handler = async (argv: any): Promise<void> => {
  const options = argv;
  // Validate daemon connection
  const daemonClient = new DaemonClient({ daemonUrl: options.daemon });
  // Check daemon health
  let isHealthy = false;
  try {
    const response = await fetch(`${options.daemon}/health`);
    isHealthy = response.ok;
  } catch {
    isHealthy = false;
  }
  if (!isHealthy) {
    console.error("Error: Cannot connect to Atlas daemon");
    console.error(`Make sure the daemon is running at ${options.daemon}`);
    Deno.exit(1);
  }

  // Create debug client
  const client = new SSEDebugClient(options.daemon, options.workspace, {
    outputPath: options.output,
    format: options.format as "json" | "jsonl" | "pretty",
    filter: options.filter?.split(",").map((t: string) => t.trim()),
    verbose: options.verbose,
  });

  // Render the monitoring UI
  const { render } = await import("ink");
  const app = render(<MonitorApp client={client} options={options} />);
  await app.waitUntilExit();

  // Print final statistics
  const stats = client.getStatistics();
  console.log("\nSession Statistics:");
  console.log(`Total Events: ${stats.totalEvents}`);
  console.log(`Duration: ${stats.duration}ms`);
  console.log(`Event Types:`, stats.eventTypes);
  if (options.output) {
    console.log(`\nLog saved to: ${options.output}`);
  }

  Deno.exit(0);
};
