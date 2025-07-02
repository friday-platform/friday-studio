import { Box, Text } from "ink";
import React from "react";
import { z } from "zod/v4";
import { Table } from "../../components/Table.tsx";

// Schema for library item
export const LibraryItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  created_at: z.string(),
  tags: z.array(z.string()),
  size_bytes: z.number(),
  description: z.string().optional(),
});

export type LibraryItem = z.infer<typeof LibraryItemSchema>;

// Utility functions
export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

export const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleDateString() + " " + date.toLocaleTimeString();
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
          {workspaceName ? `Library Items in workspace: ${workspaceName}` : "Library Items"}{" "}
          ({items.length})
        </Text>
      </Box>

      <Table
        columns={[
          { key: "ID", label: "ID", width: 10 },
          { key: "Type", label: "Type", width: 12 },
          { key: "Name", label: "Name", width: 25 },
          { key: "Size", label: "Size", width: 10 },
          { key: "Created", label: "Created", width: 20 },
          { key: "Tags", label: "Tags", width: 20 },
        ]}
        data={items.map((item) => ({
          ID: item.id.slice(0, 8),
          Type: item.type,
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
