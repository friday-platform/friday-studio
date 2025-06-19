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

export default function InteractiveCommand() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<React.ReactNode[]>([]);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [selectedWorkspaceIndex, setSelectedWorkspaceIndex] = useState(0);
  const [inputFocused, setInputFocused] = useState(true);
  const [selectorAction, setSelectorAction] = useState<"describe" | "status">(
    "describe"
  );
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
    } else if (showWorkspaceSelector && !inputFocused) {
      // Handle workspace selector navigation when input is not focused
      if (key.upArrow || inputChar === "k") {
        setSelectedWorkspaceIndex((prev) =>
          prev > 0 ? prev - 1 : workspaces.length - 1
        );
      } else if (key.downArrow || inputChar === "j") {
        setSelectedWorkspaceIndex((prev) =>
          prev < workspaces.length - 1 ? prev + 1 : 0
        );
      } else if (key.return || inputChar === " ") {
        // Select workspace and execute the appropriate command
        const selectedWorkspace = workspaces[selectedWorkspaceIndex];
        setShowWorkspaceSelector(false);
        setInputFocused(true);
        if (selectorAction === "describe") {
          executeDescribeCommand(selectedWorkspace.slug);
        } else if (selectorAction === "status") {
          executeStatusCommand(selectedWorkspace.slug);
        }
      } else if (key.tab) {
        // Focus input
        setInputFocused(true);
      }
    } else if (inputFocused) {
      // Handle input when focused
      if (key.escape && showWorkspaceSelector) {
        // Blur input when workspace selector is active
        setInputFocused(false);
      } else if (key.return) {
        if (input.trim()) {
          executeCommand(input.trim());
          setInput("");
        }
      } else if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
      } else if (
        inputChar &&
        !key.ctrl &&
        !key.meta &&
        inputChar.length === 1
      ) {
        setInput((prev) => prev + inputChar);
      }
    }
  });

  const executeCommand = async (command: string) => {
    try {
      // Parse the command
      const args = command.trim().split(/\s+/);

      // Handle built-in commands
      if (args[0] === "/exit" || args[0] === "exit" || args[0] === "quit") {
        exit();
        return;
      }

      if (args[0] === "/clear" || args[0] === "clear") {
        // Clear the output history
        setOutput([]);
        console.clear();
        return;
      }

      if (args[0] === "/commands") {
        // Show command list
        setOutput((prev) => [
          ...prev,
          <Box flexDirection="column" marginLeft={2}>
            <Box>
              <Text color="cyan">/list</Text>
              <Text color="gray">
                List all available workspaces with status
              </Text>
            </Box>
            <Box>
              <Text color="cyan">/describe</Text>
              <Text color="gray">Show workspace definition and agents</Text>
            </Box>
            <Box>
              <Text color="cyan">/status</Text>
              <Text color="gray">Show workspace status and server info</Text>
            </Box>
            <Box>
              <Text color="cyan">/clear</Text>
              <Text color="gray">Clear output</Text>
            </Box>
            <Box>
              <Text color="cyan">/commands</Text>
              <Text color="gray">Show this command list</Text>
            </Box>
            <Box>
              <Text color="cyan">/exit</Text>
              <Text color="gray">Exit interactive mode</Text>
            </Box>
          </Box>,
          <Newline />,
        ]);
        return;
      }

      // Handle /list command
      if (args[0] === "/list") {
        try {
          const workspaces = await scanAvailableWorkspaces();
          // Use the actual React component
          setOutput((prev) => [
            ...prev,
            <WorkspaceList workspaces={workspaces} />,
            <Newline />,
          ]);
          return;
        } catch (error) {
          setOutput((prev) => [
            ...prev,
            <Text color="red">Error listing workspaces: {String(error)}</Text>,
            <Newline />,
          ]);
          return;
        }
      }

      // Handle /describe command
      if (args[0] === "/describe") {
        if (args[1]) {
          // Workspace ID provided, execute describe directly
          executeDescribeCommand(args[1]);
          return;
        } else {
          // No workspace ID, show selector
          try {
            const availableWorkspaces = await scanAvailableWorkspaces();
            if (availableWorkspaces.length === 0) {
              setOutput((prev) => [
                ...prev,
                <Text color="yellow">No workspaces found to describe</Text>,
                <Newline />,
              ]);
              return;
            }
            setWorkspaces(availableWorkspaces);
            setSelectedWorkspaceIndex(0);
            setSelectorAction("describe");
            setShowWorkspaceSelector(true);
            setInputFocused(false);
            return;
          } catch (error) {
            setOutput((prev) => [
              ...prev,
              <Text color="red">
                Error loading workspaces: {String(error)}
              </Text>,
              <Newline />,
            ]);
            return;
          }
        }
      }

      // Handle /status command
      if (args[0] === "/status") {
        if (args[1]) {
          // Workspace ID provided, execute status directly
          executeStatusCommand(args[1]);
          return;
        } else {
          // No workspace ID, show selector
          try {
            const availableWorkspaces = await scanAvailableWorkspaces();
            if (availableWorkspaces.length === 0) {
              setOutput((prev) => [
                ...prev,
                <Text color="yellow">No workspaces found to check status</Text>,
                <Newline />,
              ]);
              return;
            }
            setWorkspaces(availableWorkspaces);
            setSelectedWorkspaceIndex(0);
            setSelectorAction("status");
            setShowWorkspaceSelector(true);
            setInputFocused(false);
            return;
          } catch (error) {
            setOutput((prev) => [
              ...prev,
              <Text color="red">
                Error loading workspaces: {String(error)}
              </Text>,
              <Newline />,
            ]);
            return;
          }
        }
      }

      // Check if command starts with / but is not a known command
      if (args[0].startsWith("/")) {
        setOutput((prev) => [
          ...prev,
          <Text color="red">
            Unknown command: {args[0]}. Available commands: /list, /describe,
            /status, /clear, /commands, /exit
          </Text>,
          <Newline />,
        ]);
        return;
      }

      // Reject commands that don't start with / (allow legacy built-ins for now)
      if (!["exit", "quit", "clear"].includes(args[0])) {
        setOutput((prev) => [
          ...prev,
          <Text color="yellow">
            Commands must start with /. Try /list to see available workspaces.
          </Text>,
          <Newline />,
        ]);
        return;
      }

      // Find git repository root
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
      }).outputSync();

      if (!gitRoot.success) {
        setOutput((prev) => [
          ...prev,
          <Text color="red">Error: Not in a git repository</Text>,
          <Newline />,
        ]);
        return;
      }

      const rootPath = new TextDecoder().decode(gitRoot.stdout).trim();
      const cliPath = `${rootPath}/src/cli.tsx`;

      // Execute the atlas command
      const child = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-all",
          "--unstable-broadcast-channel",
          "--unstable-worker-options",
          "--unstable-otel",
          "--env-file",
          cliPath,
          ...args,
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      const { stdout, stderr } = await child.output();
      const output = new TextDecoder().decode(stdout);
      const error = new TextDecoder().decode(stderr);

      if (output) {
        // Clean up ANSI escape sequences and task output
        const cleanOutput = output
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
          .replace(/\[2K\[1A\[2K\[G/g, "")
          .split("\n")
          .filter((line) => line.trim() && !line.includes("Task atlas"))
          .join("\n")
          .trim();

        if (cleanOutput) {
          setOutput((prev) => [
            ...prev,
            <Text color="white">{cleanOutput}</Text>,
            <Newline />,
          ]);
        }
      }

      if (error && !error.includes("Task atlas")) {
        const cleanError = error.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
        if (cleanError) {
          setOutput((prev) => [
            ...prev,
            <Text color="red">Error: {cleanError}</Text>,
            <Newline />,
          ]);
        }
      }
    } catch (error) {
      setOutput((prev) => [
        ...prev,
        <Text color="red">Command failed: {String(error)}</Text>,
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
        <Text bold color="whiteBright">
          Atlas
        </Text>
        <Text color="whiteBright" dimColor>
          Made by Tempest
        </Text>
      </Box>

      {/* Command output */}
      {/* <Box flexDirection="column" marginBottom={1}>
        {output.map((item, index) => (
          <Box key={index}>{item}</Box>
        ))}
      </Box> */}

      {/* Workspace selector */}
      {/* {showWorkspaceSelector && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold color="yellow">
              {selectorAction === "describe"
                ? "Select a Workspace to describe:"
                : "Select a Workspace to check its status:"}
            </Text>
          </Box>
          <Newline />
          {workspaces.map((workspace, index) => (
            <Box key={index} marginLeft={2}>
              <Text>
                <Text
                  color={
                    index === selectedWorkspaceIndex && !inputFocused
                      ? "green"
                      : "gray"
                  }
                >
                  {index === selectedWorkspaceIndex ? "▶ " : "  "}
                </Text>
                <Text color="blue">{workspace.id}</Text>
                {" - "}
                <Text color="yellow">{workspace.name}</Text>{" "}
                <Text color={workspace.isRunning ? "green" : "gray"}>
                  ({workspace.isRunning ? "Running" : "Stopped"})
                </Text>
              </Text>
            </Box>
          ))}
          <Newline />
          <Box marginLeft={2}>
            <Text color="gray">
              Use ↑/↓ to navigate, Enter/Space to select, Tab to focus input,
              Esc to blur input
            </Text>
          </Box>
        </Box>
      )} */}

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
          suggestions={["/list", "/define", "/init", "/help"]}
          placeholder="type / for commands"
          onSubmit={() => {}}
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
        />
      </Box>
    </FullScreenBox>
  );
}
