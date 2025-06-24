import * as p from "@clack/prompts";
import { Box, render, Text } from "ink";
import React from "react";
import { z } from "zod/v4";
import { Table } from "../../../cli/components/Table.tsx";
import { YargsInstance } from "../../utils/yargs.ts";

export const command = "list";
export const desc = "List library items";

export function builder(y: YargsInstance) {
  return y
    .option("type", {
      alias: "t",
      type: "string",
      description: "Filter by item type",
    })
    .option("tags", {
      type: "string",
      description: "Filter by tags (comma-separated)",
    })
    .option("since", {
      alias: "s",
      type: "string",
      description: "Show items created since (e.g., '7d', '2024-01-01')",
    })
    .option("limit", {
      alias: "l",
      type: "number",
      description: "Maximum number of items to display",
      default: 50,
    })
    .option("workspace", {
      alias: "w",
      type: "string",
      description: "Workspace directory",
    })
    .option("json", {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    })
    .option("port", {
      alias: "p",
      type: "number",
      description: "Server port",
      default: 8080,
    });
}

// Schema for library item
const LibraryItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  created_at: z.string(),
  tags: z.array(z.string()),
  size_bytes: z.number(),
  description: z.string().optional(),
});

type LibraryItem = z.infer<typeof LibraryItemSchema>;

export async function handler(argv: any) {
  const spinner = p.spinner();

  try {
    spinner.start("Fetching library items...");

    // Build query parameters
    const params = new URLSearchParams();
    if (argv.type) params.append("type", argv.type);
    if (argv.tags) params.append("tags", argv.tags);
    if (argv.since) params.append("since", argv.since);
    if (argv.limit) params.append("limit", argv.limit.toString());
    if (argv.workspace) params.append("workspace", "true");

    const serverUrl = `http://localhost:${argv.port}`;
    const response = await fetch(`${serverUrl}/library?${params}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const items = z.array(LibraryItemSchema).parse(data);

    spinner.stop("Library items fetched");

    if (argv.json) {
      console.log(JSON.stringify({ items, count: items.length }, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log("No library items found");
      return;
    }

    render(<LibraryListDisplay items={items} />);
  } catch (error) {
    spinner.stop("Failed to fetch library items");
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

interface LibraryListDisplayProps {
  items: LibraryItem[];
}

const LibraryListDisplay: React.FC<LibraryListDisplayProps> = ({ items }) => {
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString();
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Library Items ({items.length})</Text>
      </Box>

      <Table
        columns={[
          { key: "ID", label: "ID", width: 10 },
          { key: "Type", label: "Type", width: 12 },
          { key: "Name", label: "Name", width: 25 },
          { key: "Size", label: "Size", width: 10 },
          { key: "Created", label: "Created", width: 12 },
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
        <Text dimColor>Use 'atlas library get &lt;id&gt;' to view details</Text>
      </Box>
    </Box>
  );
};
