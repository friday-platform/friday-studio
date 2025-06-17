import React, { useEffect, useState } from "react";
import { Box, Newline, Text, useApp, useInput } from "ink";

export default function InteractiveCommand() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  const [cursorVisible, setCursorVisible] = useState(true);
  const { exit } = useApp();

  // Blink cursor every 500ms
  useEffect(() => {
    const interval = setInterval(() => {
      setCursorVisible((prev) => !prev);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      exit();
    } else if (key.return) {
      if (input.trim()) {
        executeCommand(input.trim());
        setInput("");
      }
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (inputChar && !key.ctrl && !key.meta && inputChar.length === 1) {
      setInput((prev) => prev + inputChar);
    }
  });

  const executeCommand = async (command: string) => {
    setOutput((prev) => [...prev, `atlas> ${command}`]);

    try {
      // Parse the command
      const args = command.trim().split(/\s+/);

      // Handle built-in commands
      if (args[0] === "exit" || args[0] === "quit") {
        exit();
        return;
      }

      if (args[0] === "clear") {
        setOutput([]);
        return;
      }

      // Find git repository root
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
      }).outputSync();

      if (!gitRoot.success) {
        setOutput((prev) => [...prev, "Error: Not in a git repository"]);
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
          setOutput((prev) => [...prev, cleanOutput]);
        }
      }

      if (error && !error.includes("Task atlas")) {
        const cleanError = error.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
        if (cleanError) {
          setOutput((prev) => [...prev, `Error: ${cleanError}`]);
        }
      }
    } catch (error) {
      setOutput((prev) => [...prev, `Command failed: ${error}`]);
    }
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          Atlas - AI Agent Orchestration Platform
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          Transform software delivery through human/AI collaboration
        </Text>
      </Box>

      <Newline />

      <Box>
        <Text bold color="yellow">
          Interactive Mode - Type commands below:
        </Text>
      </Box>

      <Newline />

      <Box flexDirection="column" marginLeft={2}>
        <Box>
          <Text color="cyan">workspaces</Text>
          <Text color="gray">List all available workspaces</Text>
        </Box>
        <Box>
          <Text color="cyan">define --workspace &lt;name&gt;</Text>
          <Text color="gray">Show workspace definition and agents</Text>
        </Box>
        <Box>
          <Text color="cyan">tui</Text>
          <Text color="gray">Launch Terminal User Interface</Text>
        </Box>
        <Box>
          <Text color="cyan">help</Text>
          <Text color="gray">Show detailed help</Text>
        </Box>
        <Box>
          <Text color="cyan">clear</Text>
          <Text color="gray">Clear output</Text>
        </Box>
        <Box>
          <Text color="cyan">exit</Text>
          <Text color="gray">Exit interactive mode</Text>
        </Box>
      </Box>

      <Newline />

      {/* Command output */}
      {output.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {output.map((line, index) => (
            <Box key={index}>
              <Text
                color={line.startsWith("atlas>")
                  ? "cyan"
                  : line.startsWith("Error:")
                  ? "red"
                  : "white"}
              >
                {line}
              </Text>
            </Box>
          ))}
          <Newline />
        </Box>
      )}

      {/* Input prompt */}
      <Box borderStyle="round" borderColor="green" paddingX={1}>
        <Text>
          {"> "}
          {input}
          <Text color="white">{cursorVisible ? "█" : " "}</Text>
        </Text>
      </Box>

      <Newline />

      <Box>
        <Text color="gray" dimColor>
          Type commands above or 'exit' to quit • Ctrl+C to exit
        </Text>
      </Box>
    </Box>
  );
}
