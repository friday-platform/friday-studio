import { useState } from "react";
import { Box, useInput } from "ink";

import { CommandInput } from "../../components/command-input.tsx";
import { MessageBuffer } from "../../components/message-buffer.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";
import { ConfigView } from "../../views/ConfigView.tsx";
import CreditsView from "../../views/CreditsView.tsx";
import Help from "../../views/help.tsx";
import { InitView } from "../../views/InitView.tsx";
import { COMMAND_REGISTRY, handleLibraryOpenCommand, parseSlashCommand } from "./index.ts";
import { SignalCommand } from "./SignalCommand.tsx";
import { AgentCommand } from "./AgentCommand.tsx";
import { JobCommand } from "./JobCommand.tsx";
import { SessionCommand } from "./SessionCommand.tsx";
import { WorkspacesCommand } from "./WorkspacesCommand.tsx";
import { LibraryCommand } from "./LibraryCommand.tsx";
import { useBracketedPaste } from "../input/use-bracketed-paste.ts";

export function Component() {
  useBracketedPaste();
  const {
    setOutputBuffer,
    conversationClient,
    conversationSessionId,
    setTypingState,
    setIsCollapsed,
    exitApp,
  } = useAppContext();
  const [view, setView] = useState<
    "help" | "command" | "init" | "config" | "credits"
  >("command");
  const [activeCommand, setActiveCommand] = useState<
    "signal" | "agent" | "job" | "session" | "workspaces" | "library" | null
  >(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(
    null,
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === "r") {
        // console.log(""); // hack to ensure the output rerenders :( // CLAUDE_IGNORE: Required for rendering
        setIsCollapsed((prev) => !prev);
      }
    },
    { isActive: true },
  );

  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  const handleLLMInput = async (input: string) => {
    if (!conversationClient || !conversationSessionId) {
      return;
    }

    // Show typing indicator
    setTypingState((prev) => ({ ...prev, isTyping: true }));

    try {
      // Just send the message - the persistent SSE listener will handle the response
      await conversationClient.sendMessage(conversationSessionId, input);

      // The persistent SSE listener will handle the response
    } catch {
      setTypingState((prev) => ({ ...prev, isTyping: false }));
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
      // Send non-slash input to LLM
      handleLLMInput(input);
      return;
    }

    // Special handling for certain commands
    if (
      parsed.command === "exit" ||
      parsed.command === "quit" ||
      parsed.command === "q"
    ) {
      // Use Ink's exit function for graceful shutdown
      exitApp();
      return;
    }

    if (parsed.command === "help") {
      setView("help");
      return;
    }

    if (parsed.command === "init") {
      setView("init");
      return;
    }

    if (parsed.command === "config") {
      setView("config");
      return;
    }

    if (parsed.command === "credits") {
      setView("credits");
      return;
    }

    if (parsed.command === "workspaces") {
      setActiveCommand("workspaces");
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
      if (parsed.args[0] === "open" && parsed.args[1]) {
        // Handle /library open <item_id> - fire and forget async operation
        handleLibraryOpenCommand(parsed.args[1], setOutputBuffer).catch(
          (error) => {
            setOutputBuffer((prev) => {
              const newMap = new Map(prev);
              newMap.set(`library-open-error-${Date.now()}`, {
                id: `library-open-error-${Date.now()}`,
                type: "error",
                content: `Unexpected error: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              });
              return newMap;
            });
          },
        );
        return;
      }

      // Default library command - show workspace selection
      setActiveCommand("library");
      return;
    }

    if (parsed.command === "session") {
      setActiveCommand("session");
      return;
    }

    if (parsed.command === "clear") {
      setOutputBuffer(new Map());
      return;
    }

    // Check command registry
    const commandDef = COMMAND_REGISTRY[parsed.command];
    if (!commandDef) {
      setOutputBuffer((prev) => {
        const newMap = new Map(prev);
        newMap.set(`error-unknown-${Date.now()}`, {
          id: `error-unknown-${Date.now()}`,
          type: "error",
          content: `Unknown command: /${parsed.command}. Type /help for available commands.`,
        });
        return newMap;
      });
      return;
    }

    // Execute command handler
    const outputs = commandDef.handler(parsed.args, {
      addEntry: (entry) => {
        setOutputBuffer((prev) => {
          const newMap = new Map(prev);
          newMap.set(entry.id, entry);
          return newMap;
        });
      },
    });

    outputs.forEach((output) => {
      setOutputBuffer((prev) => {
        const newMap = new Map(prev);
        newMap.set(output.id, output);
        return newMap;
      });
    });
  };

  return (
    <Box
      flexDirection="column"
      padding={1}
      alignItems="flex-start"
      width={dimensions.paddedWidth}
    >
      {view === "command" && (
        <>
          {/* Message buffer for SSE handling and output display */}
          <MessageBuffer />

          {/* Command components */}
          {activeCommand === "signal" && (
            <SignalCommand
              key="signal-command"
              onComplete={() => setActiveCommand(null)}
            />
          )}
          {activeCommand === "agent" && (
            <AgentCommand
              key="agent-command"
              onComplete={() => setActiveCommand(null)}
            />
          )}
          {activeCommand === "job" && (
            <JobCommand
              key="job-command"
              onComplete={() => setActiveCommand(null)}
            />
          )}
          {activeCommand === "session" && (
            <SessionCommand
              key="session-command"
              onComplete={() => setActiveCommand(null)}
            />
          )}
          {activeCommand === "workspaces" && (
            <WorkspacesCommand
              key="workspaces-command"
              onComplete={(workspace) => {
                if (workspace) {
                  setSelectedWorkspace(workspace);
                }
                setActiveCommand(null);
              }}
            />
          )}
          {activeCommand === "library" && (
            <LibraryCommand
              key="library-command"
              onComplete={() => setActiveCommand(null)}
            />
          )}

          {/* Show command input when no active command */}
          {!activeCommand && (
            <CommandInput
              onSubmit={handleCommand}
              selectedWorkspace={selectedWorkspace}
            />
          )}
        </>
      )}

      {view === "help" && <Help onExit={() => setView("command")} />}
      {view === "init" && <InitView onExit={() => setView("command")} />}
      {view === "config" && <ConfigView onExit={() => setView("command")} />}
      {view === "credits" && <CreditsView onExit={() => setView("command")} />}
    </Box>
  );
}
