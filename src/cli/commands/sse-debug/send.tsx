import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { SSEDebugClient, SSEDebugEvent } from "../../utils/sse-debug-client.ts";
import { DaemonClient } from "../../utils/daemon-client.ts";
import { YargsInstance } from "../../utils/yargs.ts";
import { getAtlasDaemonUrl } from "@atlas/tools";

interface SendState {
  status: "idle" | "creating-session" | "sending" | "monitoring" | "complete" | "error";
  sessionId?: string;
  message: string;
  sentAt?: number;
  events: SSEDebugEvent[];
  error?: string;
  responseComplete: boolean;
  responseContent: string;
}

const SendUI = ({ state }: { state: SendState }) => {
  const formatDuration = (ms: number) => `${ms}ms`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="white">
          SSE Send & Monitor
        </Text>
      </Box>

      {/* Status */}
      <Box marginBottom={1}>
        <Text>Status:</Text>
        {state.status === "creating-session" && <Spinner label="Creating session..." />}
        {state.status === "sending" && <Spinner label="Sending message..." />}
        {state.status === "monitoring" && <Spinner label="Receiving response..." />}
        {state.status === "complete" && <Text color="green">✓ Complete</Text>}
        {state.status === "error" && <Text color="red">✗ Error</Text>}
      </Box>

      {/* Session Info */}
      {state.sessionId && (
        <Box marginBottom={1}>
          <Text>Session:</Text>
          <Text color="cyan">{state.sessionId}</Text>
        </Box>
      )}

      {/* Message */}
      <Box marginBottom={1}>
        <Text>Message:</Text>
        <Text color="white">{state.message}</Text>
      </Box>

      {/* Timing */}
      {state.sentAt && (
        <Box marginBottom={1}>
          <Text>Response Time:</Text>
          {state.responseComplete
            ? <Text color="cyan">{formatDuration(Date.now() - state.sentAt)}</Text>
            : <Spinner label={formatDuration(Date.now() - state.sentAt)} />}
        </Box>
      )}

      {/* Events Summary */}
      {state.events.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>Events Received: {state.events.length}</Text>
          <Box paddingLeft={2}>
            {Object.entries(
              state.events.reduce((acc, event) => {
                acc[event.parsed.type] = (acc[event.parsed.type] || 0) + 1;
                return acc;
              }, {} as Record<string, number>),
            ).map(([type, count]) => (
              <Text key={type}>
                {type}: {count}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* Response Content */}
      {state.responseContent && (
        <Box flexDirection="column" borderStyle="single" paddingX={1} marginBottom={1}>
          <Text bold>Response:</Text>
          <Text>{state.responseContent.slice(0, 500)}</Text>
          {state.responseContent.length > 500 && <Text dimColor>... (truncated)</Text>}
        </Box>
      )}

      {/* Error */}
      {state.error && (
        <Box marginTop={1}>
          <Text color="red">Error: {state.error}</Text>
        </Box>
      )}
    </Box>
  );
};

const SendApp = ({
  client,
  message,
  options,
}: {
  client: SSEDebugClient;
  message: string;
  options: any;
}) => {
  const [state, setState] = useState<SendState>({
    status: "creating-session",
    message,
    events: [],
    responseComplete: false,
    responseContent: "",
  });

  useEffect(() => {
    let isMounted = true;
    const abortController = new AbortController();

    const sendAndMonitor = async () => {
      try {
        // Create session
        const session = await client.createSession({ createOnly: true });
        if (!isMounted) return;

        setState((prev) => ({
          ...prev,
          status: "sending",
          sessionId: session.sessionId,
        }));

        // Send message
        const sentAt = Date.now();
        await client.sendMessage(session.sessionId, message);
        if (!isMounted) return;

        setState((prev) => ({
          ...prev,
          status: "monitoring",
          sentAt,
        }));

        // Monitor response
        const iterator = await client.debugStreamEvents(
          session.sessionId,
          session.sseUrl,
          abortController.signal,
        );

        let responseContent = "";
        let messageComplete = false;

        for await (const event of iterator) {
          if (!isMounted) break;

          setState((prev) => ({
            ...prev,
            events: [...prev.events, event],
          }));

          // Extract content from message chunks
          if (event.parsed.type === "message_chunk") {
            const data = event.parsed.data as any;
            if (data?.content) {
              responseContent += data.content;
              setState((prev) => ({
                ...prev,
                responseContent: responseContent,
              }));
            }
          }

          // Check for completion
          if (event.parsed.type === "message_complete") {
            messageComplete = true;
            if (options.waitComplete) {
              break;
            }
          }

          // Auto-stop after timeout if specified
          if (options.timeout && Date.now() - sentAt > options.timeout * 1000) {
            break;
          }
        }

        if (isMounted) {
          setState((prev) => ({
            ...prev,
            status: "complete",
            responseComplete: messageComplete,
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

    sendAndMonitor();

    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, [client, message, options]);

  return <SendUI state={state} />;
};

export const command = "send <message>";
export const desc = "Send a message and monitor the response";

export function builder(y: YargsInstance) {
  return y
    .positional("message", {
      describe: "Message to send",
      type: "string",
      demandOption: true,
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
    .option("wait-complete", {
      describe: "Wait for message_complete event before exiting",
      type: "boolean",
    })
    .option("timeout", {
      alias: "t",
      describe: "Timeout in seconds",
      type: "number",
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
    })
    .option("verbose", {
      alias: "v",
      describe: "Verbose output",
      type: "boolean",
    });
}

export const handler = async (argv: any): Promise<void> => {
  const { message, ...options } = argv;

  try {
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
      verbose: options.verbose,
    });

    // Initialize logging
    await client.initializeLogging();

    // Render the send UI
    const { render } = await import("ink");
    const app = render(<SendApp client={client} message={message} options={options} />);
    await app.waitUntilExit();

    // Print summary
    const stats = client.getStatistics();
    console.log("\nSummary:");
    console.log(`Total Events: ${stats.totalEvents}`);
    console.log(`Event Types:`, stats.eventTypes);
    if (options.output) {
      console.log(`\nLog saved to: ${options.output}`);
    }

    Deno.exit(0);
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
