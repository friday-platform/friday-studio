import React from "react";
import { Text } from "ink";
import { ChatMessage } from "../../components/chat-message.tsx";
import { GitDiff } from "../../components/git-diff.tsx";
import { MultiSelect } from "../../components/multi-select.tsx";
import { MarkdownDisplay } from "../../components/markdown-display.tsx";
import { DirectoryTree } from "../../components/directory-tree.tsx";
import { testEvents } from "./components-test-data.ts";

function generateTimestamp() {
  const now = new Date();
  return now
    .toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })
    .toLowerCase()
    .replace(/\s/g, "");
}

export function handleComponentsCommand(
  setOutputBuffer: React.Dispatch<React.SetStateAction<any[]>>,
) {
  const timestamp = generateTimestamp();
  const components = [];

  // 3. LLM Thinking
  components.push({
    id: `components-llm-thinking-${Date.now()}`,
    component: (
      <>
        <Text color="cyan" bold>
          3. LLM Thinking (llm_thinking)
        </Text>
        <MarkdownDisplay
          content={testEvents.llm_thinking.data.content}
          dimColor
        />
      </>
    ),
  });

  // 4. Selection List
  components.push({
    id: `components-selection-list-${Date.now()}`,
    component: (
      <>
        <Text color="cyan" bold>
          4. Selection List (selection_list)
        </Text>
        <ChatMessage
          author={testEvents.selection_list.data.label}
          authorColor="yellow"
        >
          <MultiSelect
            options={testEvents.selection_list.data.options}
            isDisabled
          />
        </ChatMessage>
      </>
    ),
  });

  // 5. File Diff
  components.push({
    id: `components-file-diff-${Date.now()}`,
    component: (
      <>
        <Text color="cyan" bold>
          5. File Diff (file_diff)
        </Text>
        <ChatMessage
          author="Atlas"
          date={timestamp}
          message={testEvents.file_diff.data.message}
        >
          <GitDiff
            diffContent={testEvents.file_diff.data.diffContent}
            startingLine={testEvents.file_diff.data.startingLine}
            endingLine={testEvents.file_diff.data.endingLine}
          />
        </ChatMessage>
      </>
    ),
  });

  // 6. Directory Listing
  components.push({
    id: `components-directory-listing-${Date.now()}`,
    component: (
      <>
        <Text color="cyan" bold>
          6. Directory Listing (directory_listing)
        </Text>

        <DirectoryTree tree={testEvents.directory_listing.data.tree} />
      </>
    ),
  });

  // Update the output buffer with all components
  setOutputBuffer((prev) => [...prev, ...components]);
}
