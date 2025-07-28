import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { DiagnosticsCollector } from "../../../utils/diagnostics-collector.ts";
import { getAtlasClient } from "@atlas/client";

interface SendDiagnosticsCommandProps {
  onComplete: () => void;
}

function SendDiagnosticsCommandComponent({ onComplete }: SendDiagnosticsCommandProps) {
  const [status, setStatus] = useState<"collecting" | "uploading" | "done" | "error">("collecting");
  const [message, setMessage] = useState("Collecting diagnostic information...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sendDiagnostics = async () => {
      let gzipPath: string | undefined;

      try {
        // Collect diagnostics
        const collector = new DiagnosticsCollector();
        gzipPath = await collector.collectAndArchive();

        // Check size
        const fileInfo = await Deno.stat(gzipPath);
        if (fileInfo.size > 100 * 1024 * 1024) { // 100MB
          throw new Error("Diagnostic archive too large (>100MB). Please contact support.");
        }

        setStatus("uploading");
        setMessage("Sending diagnostics to Atlas developers...");

        // Upload via client
        const client = getAtlasClient();
        await client.sendDiagnostics(gzipPath);

        // Clean up temp file
        await Deno.remove(gzipPath).catch(() => {}); // Ignore cleanup errors

        setStatus("done");
        setMessage("Diagnostics sent successfully!");

        // Complete after showing success for a moment
        setTimeout(() => {
          onComplete();
        }, 2000);
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));

        // Try to clean up on error too
        if (gzipPath) {
          await Deno.remove(gzipPath).catch(() => {});
        }

        // Complete after showing error for a moment
        setTimeout(() => {
          onComplete();
        }, 3000);
      }
    };

    sendDiagnostics();
  }, [onComplete]);

  if (status === "error") {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (status === "done") {
    return (
      <Box>
        <Text color="green">{message}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Spinner label={message} />
    </Box>
  );
}

// Create a wrapper class to match the expected interface
export class SendDiagnosticsCommand {
  private onComplete: () => void;

  constructor({ onComplete }: { onComplete: () => void }) {
    this.onComplete = onComplete;
  }

  render() {
    return <SendDiagnosticsCommandComponent onComplete={this.onComplete} />;
  }
}
