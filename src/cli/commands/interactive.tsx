import React from "react";
import { Box, Newline, Text } from "ink";

export default function InteractiveCommand() {
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
          Available Commands:
        </Text>
      </Box>

      <Newline />

      <Box flexDirection="column" marginLeft={2}>
        <Box>
          <Text color="cyan">workspaces</Text>
          <Text color="gray">                    List all available workspaces</Text>
        </Box>
        <Box>
          <Text color="cyan">define --workspace &lt;name&gt;</Text>
          <Text color="gray">     Show workspace definition and agents</Text>
        </Box>
        <Box>
          <Text color="cyan">tui</Text>
          <Text color="gray">                           Launch Terminal User Interface</Text>
        </Box>
        <Box>
          <Text color="cyan">workspace serve</Text>
          <Text color="gray">               Start workspace server</Text>
        </Box>
        <Box>
          <Text color="cyan">help</Text>
          <Text color="gray">                          Show detailed help</Text>
        </Box>
      </Box>

      <Newline />

      <Box>
        <Text bold color="yellow">
          Quick Start:
        </Text>
      </Box>

      <Newline />

      <Box flexDirection="column" marginLeft={2}>
        <Box>
          <Text color="gray">1. </Text>
          <Text color="white">atlas workspaces</Text>
          <Text color="gray"> - See all available workspaces</Text>
        </Box>
        <Box>
          <Text color="gray">2. </Text>
          <Text color="white">atlas define --workspace k8s-assistant</Text>
          <Text color="gray"> - Explore a workspace</Text>
        </Box>
        <Box>
          <Text color="gray">3. </Text>
          <Text color="white">atlas tui</Text>
          <Text color="gray"> - Interactive mode with workspace selection</Text>
        </Box>
      </Box>

      <Newline />

      <Box>
        <Text color="gray" dimColor>
          Run 'atlas help' for complete command reference
        </Text>
      </Box>
    </Box>
  );
}
