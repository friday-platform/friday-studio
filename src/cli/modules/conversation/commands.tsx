import { Box, Text } from "ink";
import { getAtlasClient } from "@atlas/client";
import { formatVersionDisplay, getVersionInfo } from "../../../utils/version.ts";
import { createTempFileAndOpen } from "../../utils/file-opener.ts";
import { GitDiff } from "../../components/git-diff.tsx";
import { ChatMessage } from "../../components/chat-message.tsx";
import { CommandContext, OutputEntry } from "./types.ts";
import { MarkdownSandboxCommand } from "./MarkdownSandboxCommand.tsx";
import { SendDiagnosticsCommand } from "./SendDiagnosticsCommand.tsx";

export const handleWorkspacesCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `workspaces-trigger-${Date.now()}`,
    component: <Text>Select a workspace:</Text>,
  });
  return [];
};

export const handleSignalsCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode for signals
  context.addEntry({
    id: `signals-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its signals:</Text>,
  });
  return [];
};

export const handleAgentsCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `agents-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its agents:</Text>,
  });
  return [];
};

export const handleLibraryCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `library-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its library:</Text>,
  });
  return [];
};

export const handleSessionsCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Switch to workspace selection mode
  context.addEntry({
    id: `sessions-trigger-${Date.now()}`,
    component: <Text>Select a workspace to view its sessions:</Text>,
  });
  return [];
};

export const handleVersionCommand = (_args: string[]): OutputEntry[] => {
  const versionInfo = getVersionInfo();
  const versionLines = formatVersionDisplay(versionInfo);

  return versionLines.map((line, index) => ({
    id: `version-line-${Date.now()}-${index}`,
    component: <Text>{line}</Text>,
  }));
};

export const handleClearCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Clear the output buffer by setting it to empty
  context.addEntry({
    id: `clear-${Date.now()}`,
    component: <Text dimColor>Output cleared</Text>,
  });
  return [];
};

export const handleInitCommand = (_args: string[]): OutputEntry[] => {
  // Init command switches to its own view, no output entries needed
  return [];
};

export const handleCreditsCommand = (_args: string[]): OutputEntry[] => {
  // Credits command switches to its own view, no output entries needed
  return [];
};

export const handleConfigCommand = (_args: string[]): OutputEntry[] => {
  // Config command switches to its own view, no output entries needed
  return [];
};

export const handleStatusCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  // Perform async health check
  const checkDaemonStatus = async () => {
    try {
      // Use getAtlasClient for consistent behavior, but with a short timeout
      const client = getAtlasClient({ timeout: 1000 }); // 1 second timeout for status check
      const isHealthy = await client.isHealthy();

      if (isHealthy) {
        context.addEntry({
          id: `status-success-${Date.now()}`,
          component: (
            <Box paddingLeft={1}>
              <Text color="green">✓ Atlas daemon is running</Text>
            </Box>
          ),
        });
      } else {
        context.addEntry({
          id: `status-not-running-${Date.now()}`,
          component: (
            <Box paddingLeft={1}>
              <Text color="yellow">◆ Atlas daemon is not running</Text>
            </Box>
          ),
        });
      }
    } catch (_error) {
      context.addEntry({
        id: `status-error-${Date.now()}`,
        component: (
          <Box paddingLeft={1}>
            <Text color="yellow">◆ Atlas daemon is not running</Text>
          </Box>
        ),
      });
    }
  };

  // Fire and forget async operation
  checkDaemonStatus();

  // Return loading message
  return [
    {
      id: `status-loading-${Date.now()}`,
      component: (
        <Box paddingLeft={1}>
          <Text dimColor>Checking daemon status...</Text>
        </Box>
      ),
    },
  ];
};

export const handleDiffCommand = (_args: string[]): OutputEntry[] => {
  // Show example git diff
  const exampleDiff = `function calculateTotal(items) {
-  let total = 0;
-  for (let i = 0; i < items.length; i++) {
-    total += items[i].price;
-  }
+  return items.reduce((total, item) => total + item.price, 0);
}

function processOrder(order) {
  const total = calculateTotal(order.items);
+  const tax = total * 0.08;
+  const finalTotal = total + tax;
-  return { total };
+  return { total, tax, finalTotal };
}`;

  const now = new Date();
  const timestamp = now
    .toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })
    .toLowerCase()
    .replace(/\s/g, "");

  return [
    {
      id: `diff-output-${Date.now()}`,
      component: (
        <Box flexDirection="column">
          <ChatMessage
            author="Δ Atlas"
            date={timestamp}
            message="Here's an example git diff:"
            authorColor="blue"
          />
          <GitDiff diffContent={exampleDiff} startingLine={1} endingLine={15} />
        </Box>
      ),
    },
  ];
};

export const handleMarkdownCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  const markdownEntry = new MarkdownSandboxCommand({
    onComplete: () => {
      // No additional action needed after completion
    },
  });

  context.addEntry(markdownEntry);
  return [];
};

/**
 * Handle /library open <item_id> command
 */
export const handleLibraryOpenCommand = async (
  itemId: string,
  addOutputEntry: (entry: OutputEntry) => void,
) => {
  try {
    const client = getAtlasClient();

    // Show loading message
    addOutputEntry({
      id: `library-open-loading-${Date.now()}`,
      component: <Text dimColor>Opening library item {itemId}...</Text>,
    });

    // We need to search for the item across all workspaces since we don't have workspace context
    // First try to get the item directly from global library
    let libraryItem;
    try {
      libraryItem = await client.getLibraryItem(itemId, true);
    } catch (error) {
      // If global library doesn't work, we'd need workspace-specific search
      // For now, show an error about needing workspace context
      addOutputEntry({
        id: `library-open-error-${Date.now()}`,
        component: (
          <Text color="red">
            Could not find library item '{itemId}'. Library items may be workspace-specific.
            {error instanceof Error ? ` Error: ${error.message}` : ""}
          </Text>
        ),
      });
      return;
    }

    if (!libraryItem.content) {
      addOutputEntry({
        id: `library-open-error-${Date.now()}`,
        component: (
          <Text color="red">
            Library item '{itemId}' has no content to open.
          </Text>
        ),
      });
      return;
    }

    // Create temporary file and open it
    const openResult = await createTempFileAndOpen(
      libraryItem.item,
      libraryItem.content,
    );

    if (openResult.success) {
      addOutputEntry({
        id: `library-open-success-${Date.now()}`,
        component: (
          <Text color="green">
            Opened '{libraryItem.item.name}' in default application.
            {openResult.tempPath && <Text dimColor>(Temporary file: {openResult.tempPath})</Text>}
          </Text>
        ),
      });
    } else {
      addOutputEntry({
        id: `library-open-error-${Date.now()}`,
        component: <Text color="red">Failed to open file: {openResult.error}</Text>,
      });
    }
  } catch (error) {
    addOutputEntry({
      id: `library-open-error-${Date.now()}`,
      component: (
        <Text color="red">
          Error opening library item: {error instanceof Error ? error.message : String(error)}
        </Text>
      ),
    });
  }
};

export const handleSendDiagnosticsCommand = (
  _args: string[],
  context: CommandContext,
): OutputEntry[] => {
  const diagnosticsCommand = new SendDiagnosticsCommand({
    onComplete: () => {
      // No additional action needed after completion
    },
  });

  context.addEntry({
    id: `send-diagnostics-${Date.now()}`,
    component: diagnosticsCommand.render(),
  });
  return [];
};
