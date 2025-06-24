import React from "react";
import { render } from "ink";
import { Box, Text } from "ink";
import * as p from "@clack/prompts";
import { z } from "zod/v4";
import yargs from "yargs";

export const command = "get <id>";
export const desc = "Get library item details";

export function builder(y: ReturnType<typeof yargs>) {
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

// Schema for library item with content
const LibraryItemDetailSchema = z.object({
  item: z.object({
    id: z.string(),
    type: z.string(),
    name: z.string(),
    created_at: z.string(),
    tags: z.array(z.string()),
    size_bytes: z.number(),
    description: z.string().optional(),
    metadata: z.object({
      format: z.string(),
      engine: z.string().optional(),
      template_id: z.string().optional(),
      created_by: z.string().optional(),
    }).optional(),
  }),
  content: z.string().optional(),
});

type LibraryItemDetail = z.infer<typeof LibraryItemDetailSchema>;

export async function handler(argv: any) {
  const spinner = p.spinner();

  if (!argv.id) {
    console.error("Error: Item ID is required");
    process.exit(1);
  }

  try {
    spinner.start(`Fetching item ${argv.id}...`);

    // Build query parameters
    const params = new URLSearchParams();
    if (argv.content) params.append("content", "true");

    const serverUrl = `http://localhost:${argv.port}`;

    // First, try with the exact ID
    let response = await fetch(`${serverUrl}/library/${argv.id}?${params}`);

    // If not found and ID looks like a partial ID (short), try to find by prefix
    if (!response.ok && response.status === 404 && argv.id.length < 20) {
      // Get all items and find one that starts with this ID
      const listResponse = await fetch(`${serverUrl}/library`);
      if (listResponse.ok) {
        const items = await listResponse.json();
        const matchingItem = items.find((item: any) => item.id.startsWith(argv.id));

        if (matchingItem) {
          // Try again with the full ID
          response = await fetch(`${serverUrl}/library/${matchingItem.id}?${params}`);
        }
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const itemDetail = LibraryItemDetailSchema.parse(data);

    spinner.stop("Item fetched successfully");

    if (argv.json) {
      console.log(JSON.stringify(itemDetail, null, 2));
      return;
    }

    render(<ItemDetailDisplay itemDetail={itemDetail} includeContent={argv.content} />);
  } catch (error) {
    spinner.stop("Failed to fetch item");
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

interface ItemDetailDisplayProps {
  itemDetail: LibraryItemDetail;
  includeContent: boolean;
}

const ItemDetailDisplay: React.FC<ItemDetailDisplayProps> = ({ itemDetail, includeContent }) => {
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
          <Box paddingLeft={2} paddingY={1} borderStyle="single" borderColor="gray">
            <Text>{itemDetail.content}</Text>
          </Box>
        </>
      )}

      {!includeContent && (
        <Box marginTop={1}>
          <Text dimColor>
            Use --content flag to include item content
          </Text>
        </Box>
      )}
    </Box>
  );
};
