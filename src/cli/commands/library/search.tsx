import { spinner } from "../../utils/prompts.tsx";
import { Box, render, Text } from "ink";
import React from "react";
import { Table } from "../../../cli/components/table.tsx";
import { YargsInstance } from "../../utils/yargs.ts";
import { getAtlasClient } from "@atlas/client";
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

// Import the type from the client
import type { LibrarySearchResult } from "@atlas/client";

export async function handler(argv: SearchArgs) {
  const s = spinner();

  if (!argv.query) {
    console.error("Error: Search query is required");
    process.exit(1);
  }

  try {
    s.start(`Searching for "${argv.query}"...`);

    const client = getAtlasClient({ url: `http://localhost:${argv.port}` });

    // Build query object
    const query = {
      query: argv.query,
      type: argv.type,
      tags: argv.tags ? argv.tags.split(",").map((tag: string) => tag.trim()) : undefined,
      limit: argv.limit,
    };

    const result = await client.searchLibrary(query);

    s.stop(`Found ${result.items.length} results`);

    if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.items.length === 0) {
      console.log(`No results found for "${argv.query}"`);
      return;
    }

    const { unmount } = render(
      <SearchResultsDisplay result={result} query={argv.query} />,
    );
    setTimeout(() => unmount(), 100);
  } catch (error) {
    s.stop("Search failed");
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

interface SearchResultsDisplayProps {
  result: LibrarySearchResult;
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
        <Text dimColor>Use '/library open &lt;id&gt;' to open items</Text>
      </Box>
    </Box>
  );
};
