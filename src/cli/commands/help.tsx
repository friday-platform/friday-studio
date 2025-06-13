import React from "react";
import { Box, Newline, Text } from "ink";

export default function HelpCommand() {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          Atlas - AI Agent Orchestration Platform
        </Text>
      </Box>
      <Newline />
      <Box>
        <Text bold>Usage:</Text>
      </Box>
      <Box>
        <Text>atlas &lt;command&gt; [subcommand] [options]</Text>
      </Box>
      <Newline />
      <Box>
        <Text bold>Quick Commands:</Text>
      </Box>
      <Box>
        <Text>workspace Start workspace server (default)</Text>
      </Box>
      <Box>
        <Text>workspace init Initialize new workspace</Text>
      </Box>
      <Box>
        <Text>workspace status Show workspace status</Text>
      </Box>
      <Newline />
      {/* <Box>
        <Text>sig &lt;name&gt; -d '{`{}`}' Trigger a signal</Text>
      </Box>
      <Box>
        <Text>sig list List all signals</Text>
      </Box>
      <Newline /> */}
      <Box>
        <Text>session List active sessions</Text>
      </Box>
      <Box>
        <Text>session get &lt;id&gt; Show session details</Text>
      </Box>
      <Box>
        <Text>ps List active sessions</Text>
      </Box>
      <Newline />
      <Box>
        <Text>agent List all agents</Text>
      </Box>
      <Box>
        <Text>logs &lt;id&gt; Stream session logs</Text>
      </Box>
      <Newline />
      <Box>
        <Text bold>Full Commands:</Text>
      </Box>
      <Box>
        <Text color="gray">
          workspace init [name] Initialize a new workspace
        </Text>
      </Box>
      <Box>
        <Text color="gray">workspace serve Start workspace server</Text>
      </Box>
      <Box>
        <Text color="gray">workspace list List all workspaces</Text>
      </Box>
      <Box>
        <Text color="gray">workspace status Show workspace status</Text>
      </Box>
      <Newline />
      <Box>
        <Text color="gray">session list List all active sessions</Text>
      </Box>
      <Box>
        <Text color="gray">session get &lt;id&gt; Show session details</Text>
      </Box>
      <Box>
        <Text color="gray">
          session cancel &lt;id&gt; Cancel a running session
        </Text>
      </Box>
      <Newline />
      <Box>
        <Text color="gray">signal list List all signals</Text>
      </Box>
      <Box>
        <Text color="gray">
          signal trigger &lt;name&gt; -d Trigger a signal with data
        </Text>
      </Box>
      <Box>
        <Text color="gray">signal history Show signal history</Text>
      </Box>
      <Newline />
      <Box>
        <Text color="gray">agent list List all agents</Text>
      </Box>
      <Box>
        <Text color="gray">agent describe &lt;name&gt; Show agent details</Text>
      </Box>
      <Box>
        <Text color="gray">agent test &lt;name&gt; -m Test an agent</Text>
      </Box>
      <Newline />
      <Box>
        <Text dimColor italic>
          Pro tip: Use w, s, x, a, l for even faster access
        </Text>
      </Box>
      <Newline />
      <Box>
        <Text bold>Examples:</Text>
      </Box>
      <Box>
        <Text color="gray">atlas workspace init my-project</Text>
      </Box>
      <Box>
        <Text color="gray">atlas workspace serve</Text>
      </Box>
      <Box>
        <Text color="gray">
          atlas signal trigger telephone-message --data '
          {`{"message": "Hello"}`}'
        </Text>
      </Box>
      <Box>
        <Text color="gray">atlas ps</Text>
      </Box>
      <Box>
        <Text color="gray">atlas logs sess_abc123</Text>
      </Box>
    </Box>
  );
}
