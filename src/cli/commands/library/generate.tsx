import React from "react";
import { render } from "ink";
import { Box, Text } from "ink";
import { spinner } from "../../utils/prompts.tsx";
import { z } from "zod/v4";
import { promises as fs } from "node:fs";
import yargs from "yargs";
import { YargsInstance } from "../../utils/yargs.ts";
import process from "node:process";

export const command = "generate <template> <data-file>";
export const desc = "Generate content from template";

export function builder(y: YargsInstance) {
  return y
    .positional("template", {
      describe: "Template ID to use",
      type: "string",
    })
    .positional("data-file", {
      describe: "JSON data file path",
      type: "string",
    })
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

// Schema for generation result
const GenerationResultSchema = z.object({
  content: z.string(),
  id: z.string().optional(),
  metadata: z
    .object({
      template_id: z.string(),
      generated_at: z.string(),
      input_data_hash: z.string().optional(),
    })
    .optional(),
});

type GenerationResult = z.infer<typeof GenerationResultSchema>;

export async function handler(argv: any) {
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

    // s.message("Generating content..."); // Spinner doesn't have message method

    // Prepare request body
    const requestBody = {
      template: argv.template,
      data,
      store: argv.store,
      name: argv.name,
      description: argv.description,
      tags: argv.tags ? argv.tags.split(",").map((t: string) => t.trim()) : undefined,
    };

    const serverUrl = `http://localhost:${argv.port}`;
    const response = await fetch(`${serverUrl}/library/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = GenerationResultSchema.parse(await response.json());

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
      render(<GenerationResultDisplay result={result} stored={argv.store} />);
    }
  } catch (error) {
    s.stop("Generation failed");
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

interface GenerationResultDisplayProps {
  result: GenerationResult;
  stored: boolean;
}

const GenerationResultDisplay: React.FC<GenerationResultDisplayProps> = ({
  result,
  stored,
}) => {
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

      <Box
        paddingLeft={2}
        paddingY={1}
        borderStyle="single"
        borderColor="green"
      >
        <Text>{result.content}</Text>
      </Box>

      {stored && (
        <Box marginTop={1}>
          <Text dimColor>
            Use 'atlas library get {result.id}' to retrieve this content later
          </Text>
        </Box>
      )}
    </Box>
  );
};
