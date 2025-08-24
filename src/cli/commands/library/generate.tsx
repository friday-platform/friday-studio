import { promises as fs } from "node:fs";
import process from "node:process";
import { getAtlasClient } from "@atlas/client";
import { Box, render, Text } from "ink";
import type React from "react";
import { spinner } from "../../utils/prompts.tsx";
import type { YargsInstance } from "../../utils/yargs.ts";

interface GenerateArgs {
  template: string;
  dataFile: string;
  store: boolean;
  name?: string;
  description?: string;
  tags?: string;
  output?: string;
  json: boolean;
  port: number;
}

export const command = "generate <template> <data-file>";
export const desc = "Generate content from template";

export function builder(y: YargsInstance) {
  return y
    .positional("template", { describe: "Template ID to use", type: "string" })
    .positional("data-file", { describe: "JSON data file path", type: "string" })
    .option("store", {
      alias: "s",
      type: "boolean",
      description: "Store generated content in library",
      default: false,
    })
    .option("name", {
      alias: "n",
      type: "string",
      description: "Name for stored item (required if --store)",
    })
    .option("description", {
      alias: "d",
      type: "string",
      description: "Description for stored item",
    })
    .option("tags", {
      alias: "t",
      type: "string",
      description: "Tags for stored item (comma-separated)",
    })
    .option("output", {
      alias: "o",
      type: "string",
      description: "Output file path (if not specified, prints to stdout)",
    })
    .option("json", { type: "boolean", description: "Output as JSON", default: false })
    .option("port", { alias: "p", type: "number", description: "Server port", default: 8080 });
}

// Define the result type based on what the client returns
interface GenerationResult {
  content: string;
  id?: string;
  metadata?: { template_id: string; generated_at: string; input_data_hash?: string };
}

export async function handler(argv: GenerateArgs) {
  const s = spinner();

  if (!argv.template || !argv.dataFile) {
    console.error("Error: Template ID and data file are required");
    process.exit(1);
  }

  // If storing, ensure name is provided
  if (argv.store && !argv.name) {
    console.error("Error: --name is required when using --store");
    process.exit(1);
  }

  try {
    s.start("Reading data file...");

    // Read and parse data file
    let data;
    try {
      const fileContent = await fs.readFile(argv.dataFile, "utf-8");
      data = JSON.parse(fileContent);
    } catch (error) {
      throw new Error(
        `Failed to read or parse data file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const client = getAtlasClient({ url: `http://localhost:${argv.port}` });

    // Prepare options for client call
    const options = argv.store
      ? {
          store: true,
          name: argv.name,
          description: argv.description,
          tags: argv.tags ? argv.tags.split(",").map((t: string) => t.trim()) : undefined,
        }
      : undefined;

    const result = (await client.generateFromTemplate(
      argv.template,
      data,
      options,
    )) as GenerationResult;

    s.stop("Content generated successfully");

    // Handle output
    if (argv.output) {
      await fs.writeFile(argv.output, result.content, "utf-8");
      console.log(`Content written to ${argv.output}`);
      if (result.id) {
        console.log(`Stored in library with ID: ${result.id}`);
      }
    } else if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const { unmount } = render(<GenerationResultDisplay result={result} stored={argv.store} />);
      setTimeout(() => unmount(), 100);
    }
  } catch (error) {
    s.stop("Generation failed");
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

interface GenerationResultDisplayProps {
  result: GenerationResult;
  stored: boolean;
}

const GenerationResultDisplay: React.FC<GenerationResultDisplayProps> = ({ result, stored }) => {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="green">
          ✓ Content Generated
        </Text>
      </Box>

      {stored && result.id && (
        <Box marginBottom={1}>
          <Text>
            <Text bold>Stored with ID:</Text> {result.id}
          </Text>
        </Box>
      )}

      {result.metadata && (
        <>
          <Box marginBottom={1}>
            <Text>
              <Text bold>Template:</Text> {result.metadata.template_id}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              <Text bold>Generated:</Text> {new Date(result.metadata.generated_at).toLocaleString()}
            </Text>
          </Box>
        </>
      )}

      <Box marginTop={1} marginBottom={1}>
        <Text bold>Generated Content:</Text>
      </Box>

      <Box paddingLeft={2} paddingY={1} borderStyle="single" borderColor="green">
        <Text>{result.content}</Text>
      </Box>

      {stored && (
        <Box marginTop={1}>
          <Text dimColor>Use 'atlas library get {result.id}' to retrieve this content later</Text>
        </Box>
      )}
    </Box>
  );
};
