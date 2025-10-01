import { Box, Text } from "ink";
import { z } from "zod";
import { Table } from "../../components/table.tsx";

// Schema for library item
const LibraryItemSchema = z.object({
  id: z.string(),
  source: z.string(),
  name: z.string(),
  created_at: z.string(),
  tags: z.array(z.string()),
  size_bytes: z.number(),
  description: z.string().optional(),
  mime_type: z.string().optional(),
  session_id: z.string().optional(),
  agent_ids: z.array(z.string()).optional(),
  template_id: z.string().optional(),
  generated_by: z.string().optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
});

export type LibraryItem = z.infer<typeof LibraryItemSchema>;

// Utility functions
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
};

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
};

// Component that renders the library list
export function LibraryListComponent({
  items,
  workspaceName,
}: {
  items: LibraryItem[];
  workspaceName?: string;
}) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {workspaceName ? `Library Items in workspace: ${workspaceName}` : "Library Items"} (
          {items.length})
        </Text>
      </Box>

      <Table
        columns={[
          { key: "ID", label: "ID", width: 10 },
          { key: "Source", label: "Source", width: 12 },
          { key: "Name", label: "Name", width: 25 },
          { key: "Size", label: "Size", width: 10 },
          { key: "Created", label: "Created", width: 20 },
          { key: "Tags", label: "Tags", width: 20 },
        ]}
        data={items.map((item) => ({
          ID: item.id.slice(0, 8),
          Source: item.source,
          Name: item.name,
          Size: formatBytes(item.size_bytes),
          Created: formatDate(item.created_at),
          Tags: item.tags.join(", ") || "none",
        }))}
      />

      <Box marginTop={1}>
        <Text dimColor>Use '/library open &lt;id&gt;' to open items</Text>
      </Box>
    </Box>
  );
}
