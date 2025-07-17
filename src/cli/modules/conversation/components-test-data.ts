import { z } from "zod/v4";

// Export the schemas from message-buffer.tsx for validation
export const MessageChunkEventSchema = z.object({
  type: z.literal("message_chunk"),
  data: z.object({
    content: z.string(),
    partial: z.boolean().optional(),
  }),
});

export const MessageCompleteEventSchema = z.object({
  type: z.literal("message_complete"),
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  data: z.string().optional(),
});

export const LlmThinkingEventSchema = z.object({
  type: z.literal("llm_thinking"),
  data: z.object({
    content: z.string(),
  }),
});

export const SelectionListEventSchema = z.object({
  type: z.literal("selection_list"),
  data: z.object({
    label: z.string(),
    options: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
      }),
    ),
  }),
});

export const FileDiffEventSchema = z.object({
  type: z.literal("file_diff"),
  data: z.object({
    diffContent: z.string(),
    startingLine: z.number(),
    endingLine: z.number(),
    message: z.string(),
  }),
});

// Define the recursive directory node schema
const DirectoryNodeSchema: z.ZodType<{
  name: string;
  type: "file" | "directory";
  active?: boolean;
  children?: Array<{
    name: string;
    type: "file" | "directory";
    active?: boolean;
    children?: any;
  }>;
}> = z.object({
  name: z.string(),
  type: z.enum(["file", "directory"]),
  active: z.boolean().optional(),
  children: z.array(z.lazy(() => DirectoryNodeSchema)).optional(),
});

export const DirectoryListingEventSchema = z.object({
  type: z.literal("directory_listing"),
  data: z.object({
    tree: z.lazy(() => DirectoryNodeSchema),
  }),
});

export const RespondingEventSchema = z.object({
  type: z.literal("responding"),
  data: z.object({
    message: z.string(),
  }),
});

// Test data for each event type
export const testEvents = {
  message_chunk: MessageChunkEventSchema.parse({
    type: "message_chunk",
    data: {
      content:
        "This is a test message from Atlas. It demonstrates how messages appear in the chat interface.",
      partial: false,
    },
  }),

  message_complete: MessageCompleteEventSchema.parse({
    type: "message_complete",
  }),

  error: ErrorEventSchema.parse({
    type: "error",
    data: "This is a test error message to show how errors are displayed",
  }),

  llm_thinking: LlmThinkingEventSchema.parse({
    type: "llm_thinking",
    data: {
      content: `## LLM Thinking Display

This shows how the LLM's thought process appears:

- It's rendered as **markdown**
- It appears in a *dimmed* style
- It supports all markdown features like:
  1. Numbered lists
  2. Code blocks
  3. Blockquotes

\`\`\`typescript
// Example code block
const example = "This is dimmed markdown";
\`\`\`

> This is a blockquote showing deep thoughts...`,
    },
  }),

  selection_list: SelectionListEventSchema.parse({
    type: "selection_list",
    data: {
      label: "Please select your preferred options:",
      options: [
        { label: "TypeScript", value: "typescript" },
        { label: "JavaScript", value: "javascript" },
        { label: "Python", value: "python" },
        { label: "Go", value: "go" },
        { label: "Rust", value: "rust" },
      ],
    },
  }),

  file_diff: FileDiffEventSchema.parse({
    type: "file_diff",
    data: {
      message: "Applied changes to configuration file:",
      diffContent: `-const oldConfig = {
-  name: "old-name",
-  version: "1.0.0"
-};
+const newConfig = {
+  name: "atlas-project",
+  version: "2.0.0",
+  features: ["ai", "automation"]
+};

 // Common line that didn't change
 export default config;`,
      startingLine: 10,
      endingLine: 20,
    },
  }),

  directory_listing: DirectoryListingEventSchema.parse({
    type: "directory_listing",
    data: {
      tree: {
        name: ".",
        type: "directory",
        children: [
          { name: "package.json", type: "file" },
          { name: "tsconfig.json", type: "file" },
          {
            name: "src",
            type: "directory",
            children: [
              { name: "index.ts", type: "file" },
              { name: "utils.ts", type: "file", active: true },
              {
                name: "components",
                type: "directory",
                children: [
                  { name: "Button.tsx", type: "file" },
                  { name: "Modal.tsx", type: "file" },
                ],
              },
            ],
          },
          {
            name: "tests",
            type: "directory",
            children: [
              { name: "index.test.ts", type: "file" },
              { name: "utils.test.ts", type: "file" },
            ],
          },
          { name: "README.md", type: "file" },
          { name: ".gitignore", type: "file" },
        ],
      },
    },
  }),

  responding: RespondingEventSchema.parse({
    type: "responding",
    data: {
      message: "Analyzing your code structure...",
    },
  }),
};
