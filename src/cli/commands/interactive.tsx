import React, { useEffect, useState } from "react";
import { Box, Newline, Text, useApp, useInput } from "ink";
import { FullScreenBox } from "fullscreen-ink";
import {
  getWorkspaceStatus,
  scanAvailableWorkspaces,
  WorkspaceList,
  WorkspaceStatus,
} from "./workspace.tsx";
import DefineCommand from "./define.tsx";
import { Select, TextInput } from "@inkjs/ui";
import { ErrorAlert } from "../components/ErrorAlert.tsx";

export default function InteractiveCommand() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<React.ReactNode[]>([]);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [selectedWorkspaceIndex, setSelectedWorkspaceIndex] = useState(0);
  const [inputFocused, setInputFocused] = useState(true);
  const [selectFocused, setSelectFocused] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string>("");
  const [alertVisible, setAlertVisible] = useState(false);
  const { exit } = useApp();

  // Load available workspaces on mount
  useEffect(() => {
    const loadWorkspaces = async () => {
      try {
        const availableWorkspaces = await scanAvailableWorkspaces();
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

    // Dismiss alert on any key press when alert is visible
    if (alertVisible) {
      setAlertVisible(false);
      return;
    }

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

  const executeLoad = async (workspaceName: string) => {
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

      setOutput((prev) => [
        ...prev,
        <Text color="green">Found workspace: {selectedWorkspace.name}</Text>,
        <Text color="gray">Path: {selectedWorkspace.path}</Text>,
        <Text color="yellow">
          TODO: Implement workspace loading navigation
        </Text>,
        <Newline />,
      ]);
    } catch (error) {
      setOutput((prev) => [
        ...prev,
        <Text color="red">Failed to load workspace: {String(error)}</Text>,
        <Newline />,
      ]);
    }
  };

  const executeDescribeCommand = async (workspaceId: string) => {
    try {
      // Use the DefineCommand component directly
      setOutput((prev) => [
        ...prev,
        <DefineCommand args={[workspaceId]} />,
        <Newline />,
      ]);
    } catch (error) {
      setOutput((prev) => [
        ...prev,
        <Text color="red">Command failed: {String(error)}</Text>,
        <Newline />,
      ]);
    }
  };

  const executeStatusCommand = async (workspaceId: string) => {
    try {
      // Use the getWorkspaceStatus function and WorkspaceStatus component
      const statusData = await getWorkspaceStatus(workspaceId);
      setOutput((prev) => [
        ...prev,
        <WorkspaceStatus statusData={statusData} />,
        <Newline />,
      ]);
    } catch (error) {
      setOutput((prev) => [
        ...prev,
        <Text color="red">Status check failed: {String(error)}</Text>,
        <Newline />,
      ]);
    }
  };

  return (
    <FullScreenBox
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
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
        width={60}
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
          isDisabled={!inputFocused}
        />
      </Box>

      <Box
        flexDirection="column"
        height={workspaces.length + 2}
        width={60}
        marginTop={1}
        flexShrink={0}
      >
        <Box marginBottom={1}>
          <Text bold>&nbsp;&nbsp;Available Workspaces</Text>
        </Box>
        <Select
          visibleOptionCount={workspaces.length}
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
              console.log("Selected workspace:", selectedWorkspace);
              // You can add navigation logic here
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
          width={80}
          maxHeight={10}
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
      <ErrorAlert message={alertMessage} visible={alertVisible} />
    </FullScreenBox>
  );
}
