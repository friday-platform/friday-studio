import { useEffect, useState } from "react";
import { Box, Newline, Text, useApp, useInput } from "ink";
import { Select, TextInput } from "@inkjs/ui";
import {
  getWorkspaceStatus,
  WorkspaceList,
  WorkspaceStatus,
} from "../commands/workspace.tsx";
import { getWorkspaceRegistry } from "../../core/workspace-registry.ts";
import DefineCommand from "../commands/define.tsx";
import { ErrorAlert } from "./ErrorAlert.tsx";

interface Workspace {
  id: string;
  name: string;
  path: string;
  slug: string;
}

interface SplashScreenProps {
  onWorkspaceSelect: (workspace: Workspace) => void;
  onMinHeightChange?: (height: number) => void;
}

export const SplashScreen = ({
  onWorkspaceSelect,
  onMinHeightChange,
}: SplashScreenProps) => {
  const [output, setOutput] = useState<JSX.Element[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [inputFocused, setInputFocused] = useState(true);
  const [selectFocused, setSelectFocused] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string>("");
  const [alertVisible, setAlertVisible] = useState(false);
  const { exit } = useApp();

  // Calculate content dimensions for responsive container
  const asciiArtHeight = 14; // ASCII ship art lines
  const titleHeight = 3; // Title + subtitle + spacing
  const inputHeight = 3; // Input box height
  const workspaceHeaderHeight = 1; // "Available Workspaces" header
  const workspaceListHeight = Math.min(workspaces.length, 10); // Max 10 visible workspaces
  const spacingHeight = 8; // Margins and spacing around elements

  const requiredContentHeight =
    asciiArtHeight +
    titleHeight +
    inputHeight +
    workspaceHeaderHeight +
    workspaceListHeight +
    spacingHeight;

  const minHeight = Math.max(35, requiredContentHeight);
  const contentWidth = 60; // Fixed content width

  // Notify parent of minimum height changes
  useEffect(() => {
    if (onMinHeightChange) {
      onMinHeightChange(minHeight);
    }
  }, [minHeight, onMinHeightChange]);

  // Load registered workspaces on mount
  useEffect(() => {
    const loadWorkspaces = async () => {
      try {
        const registry = getWorkspaceRegistry();
        const registeredWorkspaces = await registry.listAll();

        // Convert registry format to the expected format
        const availableWorkspaces = registeredWorkspaces.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path,
          slug: w.id, // Use id as slug since we don't have slug in registry
        }));

        setWorkspaces(availableWorkspaces);
      } catch (error) {
        console.error("Failed to load workspaces:", error);
      }
    };
    loadWorkspaces();
  }, []);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }

    // Alert dismissal is now handled by ErrorAlert component via onDismiss callback

    // Enable select mode when down arrow or tab is pressed
    if ((key.downArrow || key.tab) && inputFocused && !selectFocused) {
      setInputFocused(false);
      setSelectFocused(true);
      return;
    }

    // Enable input mode when tab or escape is pressed from select mode
    if ((key.tab || key.escape) && selectFocused) {
      setSelectFocused(false);
      setInputFocused(true);
      return;
    }
  });

  const showAlert = (message: string) => {
    setAlertMessage(message);
    setAlertVisible(true);
  };

  const handleAlertDismiss = () => {
    setAlertVisible(false);
    // Re-focus text input after dismissing alert
    setInputFocused(true);
    setSelectFocused(false);
  };

  const executeCommand = async (command: string) => {
    const args = command.trim().split(/\s+/);

    try {
      switch (args[0]) {
        case "/exit":
        case "/quit":
          exit();
          return;

        case "/help":
          showHelp();
          return;

        case "/init":
          if (!args[1]) {
            showAlert("/init requires a path. Usage: /init <path>");
            return;
          }
          await executeInit(args[1]);
          return;

        case "/load":
          if (!args[1]) {
            showAlert(
              "/load requires a workspace name. Usage: /load <workspace-name>"
            );
            return;
          }
          await executeLoad(args[1]);
          return;

        default:
          showAlert(
            `Unknown command: ${args[0]}. Available commands: /init, /exit, /quit, /load, /help`
          );
      }
    } catch (error) {
      showAlert(`Command failed: ${String(error)}`);
    }
  };

  const showHelp = () => {
    setOutput((prev) => [
      ...prev,
      <Box flexDirection="column" marginLeft={2}>
        <Text bold color="cyan">
          Available Commands:
        </Text>
        <Box marginTop={1}>
          <Text color="yellow">/init &lt;path&gt;</Text>
          <Text color="gray">
            - Initialize a new workspace at the specified path
          </Text>
        </Box>
        <Box>
          <Text color="yellow">/load &lt;workspace-name&gt;</Text>
          <Text color="gray">- Load an existing workspace by name</Text>
        </Box>
        <Box>
          <Text color="yellow">/help</Text>
          <Text color="gray">- Show this help information</Text>
        </Box>
        <Box>
          <Text color="yellow">/exit</Text>
          <Text color="gray">- Exit the interactive UI</Text>
        </Box>
        <Box>
          <Text color="yellow">/quit</Text>
          <Text color="gray">- Exit the interactive UI</Text>
        </Box>
      </Box>,
      <Newline />,
    ]);
  };

  const executeInit = async (path: string) => {
    try {
      setOutput((prev) => [
        ...prev,
        <Text color="yellow">Initializing workspace at: {path}</Text>,
        <Newline />,
      ]);

      // Find git repository root
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
      }).outputSync();

      if (!gitRoot.success) {
        throw new Error("Not in a git repository");
      }

      const rootPath = new TextDecoder().decode(gitRoot.stdout).trim();
      const cliPath = `${rootPath}/src/cli.tsx`;

      // Execute atlas init command
      const child = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-all",
          "--unstable-broadcast-channel",
          "--unstable-worker-options",
          "--unstable-otel",
          "--env-file",
          cliPath,
          "init",
          path,
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      const { stdout, stderr } = await child.output();
      const output = new TextDecoder().decode(stdout);
      const error = new TextDecoder().decode(stderr);

      if (output) {
        setOutput((prev) => [
          ...prev,
          <Text color="green">{output.trim()}</Text>,
          <Newline />,
        ]);
      }

      if (error && !error.includes("Task atlas")) {
        setOutput((prev) => [
          ...prev,
          <Text color="red">Error: {error.trim()}</Text>,
          <Newline />,
        ]);
      }
    } catch (error) {
      setOutput((prev) => [
        ...prev,
        <Text color="red">
          Failed to initialize workspace: {String(error)}
        </Text>,
        <Newline />,
      ]);
    }
  };

  const executeLoad = (workspaceName: string) => {
    try {
      setOutput((prev) => [
        ...prev,
        <Text color="yellow">Loading workspace: {workspaceName}</Text>,
        <Newline />,
      ]);

      // Find the workspace in available workspaces
      const selectedWorkspace = workspaces.find(
        (w) =>
          w.name.toLowerCase() === workspaceName.toLowerCase() ||
          w.id === workspaceName
      );

      if (!selectedWorkspace) {
        setOutput((prev) => [
          ...prev,
          <Text color="red">
            Workspace '{workspaceName}' not found. Available workspaces:
          </Text>,
          <Newline />,
          ...workspaces.map((w) => (
            <Text key={w.id} color="gray">
              - {w.name}
            </Text>
          )),
          <Newline />,
        ]);
        return;
      }

      // Trigger workspace selection callback
      onWorkspaceSelect(selectedWorkspace);
    } catch (error) {
      setOutput((prev) => [
        ...prev,
        <Text color="red">Failed to load workspace: {String(error)}</Text>,
        <Newline />,
      ]);
    }
  };

  return (
    <>
      {/* ASCII Art */}
      <Box
        flexDirection="column"
        alignItems="center"
        marginBottom={2}
        flexShrink={0}
      >
        <Text color="blue">
          {`
                ••                 
          ••••••••••••             
           ••••••••••••            
             ••••••••••            
             •••••••••••           
            •••••••••••            
          ••••••••••••             
                ••     ••••••••••  
                ••   •••••••••     
    ••••••••••••••••••••••••••     
     •••••• •••• •••• ••••••       
      •••••••••••••••••••••        
         •••••••••••••••            `}
        </Text>
      </Box>

      {/* Title and subtitle */}
      <Box
        flexDirection="column"
        alignItems="center"
        marginBottom={3}
        flexShrink={0}
      >
        <Text bold>Atlas</Text>
        <Text dimColor>Made by Tempest</Text>
      </Box>

      {/* Centered input prompt */}
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        width={contentWidth}
        height={3}
        flexShrink={0}
      >
        <TextInput
          suggestions={["/init", "/load", "/help", "/exit", "/quit"]}
          placeholder="type / for commands"
          onSubmit={(value) => {
            // Only execute if input is not empty to prevent showing error messages for accidental Enter presses
            if (value.trim()) {
              executeCommand(value.trim());
            }
          }}
          isDisabled={!inputFocused || alertVisible}
        />
      </Box>

      <Box
        flexDirection="column"
        height={workspaceListHeight + 2} // +2 for header and spacing
        width={contentWidth}
        marginTop={1}
        flexShrink={0}
      >
        <Box marginBottom={1}>
          <Text bold>&nbsp;&nbsp;Available Workspaces</Text>
        </Box>
        <Select
          visibleOptionCount={workspaceListHeight}
          options={workspaces.map((workspace) => ({
            label: workspace.name,
            value: workspace.id,
          }))}
          onChange={(selectedWorkspaceId) => {
            // Handle workspace selection
            const selectedWorkspace = workspaces.find(
              (w) => w.id === selectedWorkspaceId
            );
            if (selectedWorkspace) {
              onWorkspaceSelect(selectedWorkspace);
            }
          }}
          isDisabled={!selectFocused}
        />
      </Box>

      {/* Command output section - below the workspace selector */}
      {output.length > 0 && (
        <Box
          flexDirection="column"
          marginTop={2}
          paddingX={2}
          width={contentWidth}
          maxHeight={Math.floor((minHeight - requiredContentHeight) * 0.3)}
          borderStyle="round"
          borderColor="gray"
          flexShrink={0}
        >
          <Box marginBottom={1}>
            <Text bold color="gray">
              Command Output:
            </Text>
          </Box>
          <Box flexDirection="column" overflowY="auto">
            {output.slice(-8).map((entry, index) => (
              <Box key={index} flexDirection="column">
                {entry}
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* ErrorAlert must be last for proper absolute positioning overlay */}
      <ErrorAlert
        message={alertMessage}
        visible={alertVisible}
        onDismiss={handleAlertDismiss}
      />
    </>
  );
};