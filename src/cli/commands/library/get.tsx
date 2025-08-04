import React from "react";
import { render } from "ink";
import { Box, Text } from "ink";
import { spinner } from "../../utils/prompts.tsx";
import { z } from "zod/v4";
import { YargsInstance } from "../../utils/yargs.ts";
import { getAtlasClient } from "@atlas/client";
import type { LibraryItemWithContent } from "@atlas/client";
import process from "node:process";

interface GetArgs {
  id: string;
  content: boolean;
  json: boolean;
  port: number;
}

export const command = "get <id>";
export const desc = "Get library item details";

export function builder(y: YargsInstance) {
  return y
    .positional("id", {
      describe: "Library item ID",
      type: "string",
    })
    .option("content", {
      alias: "c",
      type: "boolean",
      description: "Include item content",
      default: false,
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

// Type already imported from client
type LibraryItemDetail = LibraryItemWithContent;

export async function handler(argv: GetArgs) {
  const s = spinner();

  if (!argv.id) {
    console.error("Error: Item ID is required");
    process.exit(1);
  }

  try {
    s.start(`Fetching item ${argv.id}...`);

    const client = getAtlasClient({ url: `http://localhost:${argv.port}` });

    let itemDetail;
    try {
      // First, try with the exact ID
      itemDetail = await client.getLibraryItem(argv.id, argv.content);
    } catch (error) {
      // If not found and ID looks like a partial ID (short), try to find by prefix
      if (argv.id.length < 20) {
        const listResult = await client.listLibraryItems({ limit: 1000 });
        const matchingItem = listResult.items.find((item) => item.id.startsWith(argv.id));

        if (matchingItem) {
          // Try again with the full ID
          itemDetail = await client.getLibraryItem(matchingItem.id, argv.content);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    s.stop("Item fetched successfully");

    if (argv.json) {
      console.log(JSON.stringify(itemDetail, null, 2));
      return;
    }

    const { unmount } = render(
      <ItemDetailDisplay
        itemDetail={itemDetail}
        includeContent={argv.content}
      />,
    );
    setTimeout(() => unmount(), 100);
  } catch (error) {
    s.stop("Failed to fetch item");
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

interface ItemDetailDisplayProps {
  itemDetail: LibraryItemDetail;
  includeContent: boolean;
}

const ItemDetailDisplay: React.FC<ItemDetailDisplayProps> = ({
  itemDetail,
  includeContent,
}) => {
  const { item } = itemDetail;

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
        <Text bold>{item.name}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          <Text bold>ID:</Text> {item.id}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          <Text bold>Type:</Text> {item.type} | <Text bold>Format:</Text>{" "}
          {item.metadata?.format || "unknown"}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          <Text bold>Size:</Text> {formatBytes(item.size_bytes)} | <Text bold>Created:</Text>{" "}
          {formatDate(item.created_at)}
        </Text>
      </Box>

      {item.tags.length > 0 && (
        <Box marginBottom={1}>
          <Text>
            <Text bold>Tags:</Text> {item.tags.join(", ")}
          </Text>
        </Box>
      )}

      {item.description && (
        <Box marginBottom={1}>
          <Text>
            <Text bold>Description:</Text> {item.description}
          </Text>
        </Box>
      )}

      {item.metadata && (
        <>
          {item.metadata.engine && (
            <Box marginBottom={1}>
              <Text>
                <Text bold>Engine:</Text> {item.metadata.engine}
              </Text>
            </Box>
          )}
          {item.metadata.template_id && (
            <Box marginBottom={1}>
              <Text>
                <Text bold>Template:</Text> {item.metadata.template_id}
              </Text>
            </Box>
          )}
          {item.metadata.created_by && (
            <Box marginBottom={1}>
              <Text>
                <Text bold>Created By:</Text> {item.metadata.created_by}
              </Text>
            </Box>
          )}
        </>
      )}

      {includeContent && itemDetail.content && (
        <>
          <Box marginTop={1} marginBottom={1}>
            <Text bold>Content:</Text>
          </Box>
          <Box>
            <Text>{itemDetail.content}</Text>
          </Box>
        </>
      )}

      {!includeContent && (
        <Box marginTop={1}>
          <Text dimColor>Use --content flag to include item content</Text>
        </Box>
      )}
    </Box>
  );
};
