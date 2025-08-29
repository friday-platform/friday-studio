import { getAtlasClient } from "@atlas/client";
import { Box, useInput } from "ink";
import { useState } from "react";
import { CommandInput } from "../../components/command-input.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";
import CreditsView from "../../views/CreditsView.tsx";
import Help from "../../views/help.tsx";
import { useBracketedPaste } from "../input/use-bracketed-paste.ts";
import { MessageBuffer } from "../messages/message-buffer.tsx";
import { AgentCommand } from "./AgentCommand.tsx";
import { COMMAND_REGISTRY, parseSlashCommand } from "./index.ts";
import { JobCommand } from "./JobCommand.tsx";
import { LibraryCommand } from "./LibraryCommand.tsx";
import { SessionCommand } from "./SessionCommand.tsx";
import { SignalCommand } from "./SignalCommand.tsx";

export function Component() {
  useBracketedPaste();
  const {
    conversationClient,
    conversationSessionId,
    atlasSessionId,
    setIsCollapsed,
    exitApp,
    sendDiagnostics,
    setDaemonStatus,
    enableMultiline,
    typingState,
  } = useAppContext();
  const [view, setView] = useState<"help" | "command" | "init" | "config" | "credits">("command");
  const [activeCommand, setActiveCommand] = useState<
    "signal" | "agent" | "job" | "session" | "workspaces" | "library" | null
  >(null);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "r") {
        setIsCollapsed((prev) => !prev);
      }

      if (key.escape && atlasSessionId) {
        conversationClient?.cancelSession(atlasSessionId);
      }
    },
    { isActive: true },
  );

  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  const handleLLMInput = async (input: string) => {
    if (!conversationClient || !conversationSessionId) {
      // Check daemon health and potentially reinitialize
      try {
        const client = getAtlasClient({ timeout: 1000 });
        const isHealthy = await client.isHealthy();
        if (!isHealthy) {
          // Daemon is not running, don't send the message
          return;
        }
      } catch {
        // Daemon is not available
        return;
      }
      return;
    }

    // Show typing indicator

    try {
      // Just send the message - the persistent SSE listener will handle the response
      await conversationClient.sendMessage(conversationSessionId, input);

      // The persistent SSE listener will handle the response
    } catch {
      console.error("Failed to send message to LLM");
    }
  };

  // Command execution handler
  const handleCommand = (input: string) => {
    // Don't process empty input
    if (!input || input.trim() === "") {
      return;
    }

    // Parse command
    const parsed = parseSlashCommand(input);
    if (!parsed) {
      // Send non-slash input to LLM (requires daemon)
      if (!conversationClient || !conversationSessionId) {
        console.error("Cannot send message to LLM: Atlas daemon is not running");
        return;
      }
      handleLLMInput(input);
      return;
    }

    // Commands that work WITHOUT daemon connection
    if (parsed.command === "exit" || parsed.command === "quit" || parsed.command === "q") {
      exitApp();
      return;
    }

    if (parsed.command === "help") {
      setView("help");
      return;
    }

    // if (parsed.command === "config") {
    //   setView("config");
    //   return;
    // }

    if (parsed.command === "credits") {
      setView("credits");
      return;
    }

    if (parsed.command === "enable-multiline") {
      enableMultiline();
      return;
    }

    if (parsed.command === "status") {
      setDaemonStatus();
      return;
    }

    if (parsed.command === "send-diagnostics") {
      sendDiagnostics();
      return;
    }

    // Commands that REQUIRE daemon connection
    if (!conversationClient || !conversationSessionId) {
      console.error(`Cannot execute /${parsed.command}: Atlas daemon is not running`);
      return;
    }

    if (parsed.command === "signal") {
      setActiveCommand("signal");
      return;
    }

    if (parsed.command === "agent" || parsed.command === "agents") {
      setActiveCommand("agent");
      return;
    }

    if (parsed.command === "job") {
      setActiveCommand("job");
      return;
    }

    if (parsed.command === "library") {
      setActiveCommand("library");
      return;
    }

    if (parsed.command === "session") {
      setActiveCommand("session");
      return;
    }

    if (parsed.command === "enable-multiline") {
      enableMultiline();
      return;
    }

    if (parsed.command === "version") {
      conversationClient.sendPrompt(conversationSessionId, { promptName: "system_version" });
      return;
    }

    // Check command registry
    const commandDef = COMMAND_REGISTRY[parsed.command || ""];
    if (!commandDef) {
      // Instead of showing an error, send unknown slash commands to LLM
      // This allows the LLM to potentially handle custom commands or provide help
      handleLLMInput(input);
      return;
    }
  };

  return (
    <Box flexDirection="column" padding={1} alignItems="flex-start" width={dimensions.paddedWidth}>
      {view === "command" && (
        <>
          {/* Message buffer for SSE handling and output display */}
          <MessageBuffer />

          {/* Command components */}
          {activeCommand === "signal" && (
            <SignalCommand key="signal-command" onComplete={() => setActiveCommand(null)} />
          )}
          {activeCommand === "agent" && (
            <AgentCommand key="agent-command" onComplete={() => setActiveCommand(null)} />
          )}
          {activeCommand === "job" && (
            <JobCommand key="job-command" onComplete={() => setActiveCommand(null)} />
          )}
          {activeCommand === "session" && (
            <SessionCommand key="session-command" onComplete={() => setActiveCommand(null)} />
          )}
          {activeCommand === "library" && (
            <LibraryCommand key="library-command" onComplete={() => setActiveCommand(null)} />
          )}

          {/* Show command input when no active command */}
          {!activeCommand && <CommandInput onSubmit={handleCommand} disabled={typingState} />}
        </>
      )}

      {view === "help" && <Help onExit={() => setView("command")} />}
      {view === "credits" && <CreditsView onExit={() => setView("command")} />}
    </Box>
  );
}
