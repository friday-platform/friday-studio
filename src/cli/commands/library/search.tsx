import { spinner } from "../../utils/prompts.tsx";
import { Box, render, Text } from "ink";
import React from "react";
import { z } from "zod/v4";
import { Table } from "../../../cli/components/Table.tsx";
import { YargsInstance } from "../../utils/yargs.ts";
import process from "node:process";

interface SearchArgs {
  query: string;
  type?: string;
  tags?: string;
  limit: number;
  json: boolean;
  port: number;
}

export const command = "search <query>";
export const desc = "Search library content";

export function builder(y: YargsInstance) {
  return y
    .positional("query", {
      describe: "Search query",
      type: "string",
    })
    .option("type", {
      alias: "t",
      type: "string",
      description: "Filter by item type",
    })
    .option("tags", {
      type: "string",
      description: "Filter by tags (comma-separated)",
    })
    .option("limit", {
      alias: "l",
      type: "number",
      description: "Maximum number of results",
      default: 50,
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

// Schema for search response
const SearchResultSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      name: z.string(),
      created_at: z.string(),
      tags: z.array(z.string()),
      size_bytes: z.number(),
      description: z.string().optional(),
      relevance_score: z.number().optional(),
    }),
  ),
  total_results: z.number().optional(),
  query: z.string().optional(),
});

type SearchResult = z.infer<typeof SearchResultSchema>;

export async function handler(argv: SearchArgs) {
  const s = spinner();

  if (!argv.query) {
    console.error("Error: Search query is required");
    process.exit(1);
  }

  try {
    s.start(`Searching for "${argv.query}"...`);

    // Build query parameters
    const params = new URLSearchParams();
    params.append("q", argv.query);
    if (argv.type) params.append("type", argv.type);
    if (argv.tags) params.append("tags", argv.tags);
    if (argv.limit) params.append("limit", argv.limit.toString());

    const serverUrl = `http://localhost:${argv.port}`;
    const response = await fetch(`${serverUrl}/api/library/search?${params}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const result = SearchResultSchema.parse(data);

    s.stop(`Found ${result.items.length} results`);

    if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.items.length === 0) {
      console.log(`No results found for "${argv.query}"`);
      return;
    }

    render(<SearchResultsDisplay result={result} query={argv.query} />);
  } catch (error) {
    s.stop("Search failed");
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

interface SearchResultsDisplayProps {
  result: SearchResult;
  query: string;
}

const SearchResultsDisplay: React.FC<SearchResultsDisplayProps> = ({
  result,
  query,
}) => {
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
        <Text bold>
          Search Results for "{query}" ({result.items.length} items)
        </Text>
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
        data={result.items.map((item) => ({
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
