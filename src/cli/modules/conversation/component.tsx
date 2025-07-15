import { useState } from "react";
import { Box, Static, Text, useInput, useStdout } from "ink";
import { ChatMessage } from "../../components/chat-message.tsx";
import { CommandInput } from "../../components/command-input.tsx";
import { MessageBuffer } from "../../components/message-buffer.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";
import { ConfigView } from "../../views/ConfigView.tsx";
import CreditsView from "../../views/CreditsView.tsx";
import Help from "../../views/help.tsx";
import { InitView } from "../../views/InitView.tsx";
import {
  COMMAND_REGISTRY,
  handleLibraryOpenCommand,
  OutputEntry,
  parseSlashCommand,
} from "./index.ts";
import { SignalCommand } from "./SignalCommand.tsx";
import { AgentCommand } from "./AgentCommand.tsx";
import { JobCommand } from "./JobCommand.tsx";
import { SessionCommand } from "./SessionCommand.tsx";
import { WorkspacesCommand } from "./WorkspacesCommand.tsx";
import { LibraryCommand } from "./LibraryCommand.tsx";

export function Component() {
  const {
    setOutputBuffer,
    conversationClient,
    conversationSessionId,

    setTypingState,
    isInitializing,
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
  const { stdout: _stdout } = useStdout();

  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Handle Ctrl+C for graceful shutdown
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exitApp();
    }
  });

  // Add entry to output buffer
  const addOutputEntry = (entry: OutputEntry) => {
    setOutputBuffer((prev) => [...prev, entry]);
  };

  // Handle LLM input (Phase 2.1)
  const handleLLMInput = async (input: string) => {
    if (isInitializing) {
      addOutputEntry({
        id: `llm-initializing-${Date.now()}`,
        component: (
          <Text color="yellow">
            Initializing conversation system, please wait...
          </Text>
        ),
      });
      return;
    }

    if (!conversationClient || !conversationSessionId) {
      addOutputEntry({
        id: `llm-error-${Date.now()}`,
        component: (
          <Text color="red">
            Failed to initialize conversation system. Please restart the CLI.
          </Text>
        ),
      });
      return;
    }

    // Add user message using ChatMessage component
    const now = new Date();
    const userTimestamp = now
      .toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
      .toLowerCase()
      .replace(/\s/g, "");
    const currentUser = Deno.env.get("USER") || Deno.env.get("USERNAME") || "You";

    // Force immediate render by using setOutputBuffer directly
    setOutputBuffer((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        component: (
          <ChatMessage
            author={currentUser}
            date={userTimestamp}
            message={input}
            authorColor="green"
          />
        ),
      },
    ]);

    // Show typing indicator
    setTypingState((prev) => ({ ...prev, isTyping: true }));

    try {
      // Just send the message - the persistent SSE listener will handle the response
      await conversationClient.sendMessage(conversationSessionId, input);

      // The persistent SSE listener will handle the response
    } catch (error) {
      setTypingState((prev) => ({ ...prev, isTyping: false }));
      addOutputEntry({
        id: `llm-error-${Date.now()}`,
        component: (
          <Box paddingLeft={1}>
            <Text color="red">
              LLM Error: {error instanceof Error ? error.message : String(error)}
            </Text>
          </Box>
        ),
      });
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
        handleLibraryOpenCommand(parsed.args[1], addOutputEntry).catch(
          (error) => {
            addOutputEntry({
              id: `library-open-error-${Date.now()}`,
              component: (
                <Text color="red">
                  Unexpected error: {error instanceof Error ? error.message : String(error)}
                </Text>
              ),
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
      setOutputBuffer([]);
      return;
    }

    // Check command registry
    const commandDef = COMMAND_REGISTRY[parsed.command];
    if (!commandDef) {
      addOutputEntry({
        id: `error-unknown-${Date.now()}`,
        component: (
          <Text color="red">
            Unknown command: /{parsed.command}. Type /help for available commands.
          </Text>
        ),
      });
      return;
    }

    // Execute command handler
    const outputs = commandDef.handler(parsed.args, {
      addEntry: addOutputEntry,
    });

    outputs.forEach(addOutputEntry);
  };

  return (
    <Box
      flexDirection="column"
      padding={1}
      alignItems="flex-start"
      width={dimensions.paddedWidth}
    >
      <Box flexDirection="column" flexShrink={0}>
        <Static items={[1]}>
          {(item) => (
            <Box key={item} flexDirection="column" flexShrink={0}>
              <Box flexDirection="row" alignItems="center">
                <Box flexDirection="column">
                  <Text>╭───╮</Text>
                  <Text>│&nbsp;∆&nbsp;│</Text>
                  <Text>╰───╯</Text>
                </Box>

                <Box flexDirection="column">
                  <Text bold>&nbsp;Atlas.&nbsp;</Text>
                </Box>

                <Box flexDirection="column">
                  <Text dimColor>Made by Tempest.</Text>
                </Box>
              </Box>

              <Box flexDirection="column" paddingLeft={2}>
                <Text dimColor>⊕ /help for help</Text>
                <Text dimColor>∶ {Deno.cwd()}</Text>
              </Box>
            </Box>
          )}
        </Static>
      </Box>

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
