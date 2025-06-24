import { Box, Newline, Text, useInput } from "ink";

export default function HelpCommand({ onExit }: { onExit: () => void }) {
  const commands = [
    {
      command: "/help",
      description: "Show available commands and usage information",
    },
    {
      command: "/list",
      description:
        "View workspaces, sessions, signals, agents, and library items",
    },
    { command: "/init", description: "Initialize a new workspace" },
    { command: "/sessions", description: "View available workspace sessions" },
    {
      command: "/signals",
      description: "View available workspace signals",
    },
    { command: "/agents", description: "View workspace agents" },
    {
      command: "/library",
      description: "View available workspace artifacts",
    },
    { command: "/config", description: "Atlas configuration settings" },
    { command: "/logs", description: "View workspace logs" },
    { command: "/exit", description: "Exit the Atlas interactive interface" },
  ];
  useInput((_, key) => {
    if (key.return) {
      onExit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Modes</Text>
      <Text>• Interactive: atlas</Text>
      <Text>• Command Line: atlas {`<command>`}</Text>

      <Newline />

      <Text bold>Commands:</Text>

      <Box flexDirection="row" marginTop={1}>
        <Box flexDirection="column" marginRight={1}>
          {commands.map((suggestion) => (
            <Text key={suggestion.command}>{suggestion.command}</Text>
          ))}
        </Box>
        <Box flexDirection="column" paddingLeft={1}>
          {commands.map((suggestion) => (
            <Text key={`${suggestion.command}-desc`} dimColor>
              {suggestion.description}
            </Text>
          ))}
        </Box>
      </Box>

      <Newline />

      <Text bold>Press enter to continue...</Text>
      {/*      
          /add-dir - Add a new working directory
          /bug - Submit feedback about Claude Code
          /clear - Clear conversation history and free up context
          /compact - Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]
          /config - Open config panel
          /cost - Show the total cost and duration of the current session
          /doctor - Checks the health of your Claude Code installation
          /exit - Exit the REPL
          /help - Show help and available commands
          /ide - Manage IDE integrations and show status
          /init - Initialize a new CLAUDE.md file with codebase documentation
          /install-github-app - Set up Claude GitHub Actions for a repository
          /login - Switch Anthropic accounts
          /logout - Sign out from your Anthropic account
          /mcp - Manage MCP servers
          /memory - Edit Claude memory files
          /migrate-installer - Migrate from global npm installation to local installation
          /model - Set the AI model for Claude Code
          /permissions - Manage allow & deny tool permission rules
          /pr-comments - Get comments from a GitHub pull request
          /release-notes - View release notes
          /resume - Resume a conversation
          /review - Review a pull request
          /status - Show Claude Code status including version, model, account, API connectivity, and tool statuses
          /terminal-setup - Install Shift+Enter key binding for newlines
          /upgrade - Upgrade to Max for higher rate limits and more Opus
          /vim - Toggle between Vim and Normal editing modes */}
    </Box>
  );
}
