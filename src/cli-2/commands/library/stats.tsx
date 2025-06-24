import React from "react";
import { render } from "ink";
import { Box, Text } from "ink";
import * as p from "@clack/prompts";
import { z } from "zod/v4";
import yargs from "yargs";

export const command = "stats";
export const desc = "Show library statistics";

export function builder(y: ReturnType<typeof yargs>) {
  return y
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

// Schema for library statistics
const LibraryStatsSchema = z.object({
  total_items: z.number(),
  total_size_bytes: z.number(),
  types: z.record(z.number()),
  tags: z.record(z.number()).optional(),
  recent_activity: z.array(z.object({
    date: z.string(),
    items_added: z.number(),
    size_added_bytes: z.number(),
  })).optional(),
  storage_stats: z.object({
    used_bytes: z.number(),
    limit_bytes: z.number().optional(),
    percentage_used: z.number().optional(),
  }).optional(),
});

type LibraryStats = z.infer<typeof LibraryStatsSchema>;

export async function handler(argv: any) {
  const spinner = p.spinner();

  try {
    spinner.start("Fetching library statistics...");

    const serverUrl = `http://localhost:${argv.port}`;
    const response = await fetch(`${serverUrl}/library/stats`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const stats = LibraryStatsSchema.parse(await response.json());

    spinner.stop("Statistics fetched");

    if (argv.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    render(<StatsDisplay stats={stats} />);
  } catch (error) {
    spinner.stop("Failed to fetch statistics");
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

interface StatsDisplayProps {
  stats: LibraryStats;
}

const StatsDisplay: React.FC<StatsDisplayProps> = ({ stats }) => {
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatPercentage = (value: number): string => {
    return `${value.toFixed(1)}%`;
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Library Statistics</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          <Text bold>Total Items:</Text> {stats.total_items.toLocaleString()} |
          <Text bold>Total Size:</Text> {formatBytes(stats.total_size_bytes)}
        </Text>
      </Box>

      {stats.storage_stats && (
        <Box marginBottom={1}>
          <Text>
            <Text bold>Storage Used:</Text> {formatBytes(stats.storage_stats.used_bytes)}
            {stats.storage_stats.limit_bytes && (
              <Text>/ {formatBytes(stats.storage_stats.limit_bytes)}</Text>
            )}
            {stats.storage_stats.percentage_used !== undefined && (
              <Text>({formatPercentage(stats.storage_stats.percentage_used)})</Text>
            )}
          </Text>
        </Box>
      )}

      {Object.keys(stats.types).length > 0 && (
        <>
          <Box marginTop={1} marginBottom={1}>
            <Text bold>By Type:</Text>
          </Box>
          {Object.entries(stats.types)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <Box key={type} marginLeft={2}>
                <Text>• {type}: {count.toLocaleString()} items</Text>
              </Box>
            ))}
        </>
      )}

      {stats.tags && Object.keys(stats.tags).length > 0 && (
        <>
          <Box marginTop={1} marginBottom={1}>
            <Text bold>Popular Tags:</Text>
          </Box>
          {Object.entries(stats.tags)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10)
            .map(([tag, count]) => (
              <Box key={tag} marginLeft={2}>
                <Text>• {tag}: {count.toLocaleString()} items</Text>
              </Box>
            ))}
        </>
      )}

      {stats.recent_activity && stats.recent_activity.length > 0 && (
        <>
          <Box marginTop={1} marginBottom={1}>
            <Text bold>Recent Activity:</Text>
          </Box>
          {stats.recent_activity.slice(0, 7).map((activity) => (
            <Box key={activity.date} marginLeft={2}>
              <Text>
                • {activity.date}: {activity.items_added}{" "}
                items added ({formatBytes(activity.size_added_bytes)})
              </Text>
            </Box>
          ))}
        </>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          Use 'atlas library list' to view all items
        </Text>
      </Box>
    </Box>
  );
};
