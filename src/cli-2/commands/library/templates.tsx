import { spinner } from "../../utils/prompts.tsx";
import { Box, render, Text } from "ink";
import React from "react";
import { z } from "zod/v4";
import { Table } from "../../../cli/components/Table.tsx";
import { YargsInstance } from "../../utils/yargs.ts";

export const command = "templates";
export const desc = "List available templates";

export function builder(y: YargsInstance) {
  return y
    .option("workspace", {
      alias: "w",
      type: "boolean",
      description: "Show workspace-specific templates",
      default: false,
    })
    .option("platform", {
      type: "boolean",
      description: "Show platform templates",
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

// Schema for template
const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  format: z.string(),
  engine: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  examples: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

type Template = z.infer<typeof TemplateSchema>;

export async function handler(argv: any) {
  const s = spinner();

  try {
    s.start("Fetching templates...");

    // Build query parameters
    const params = new URLSearchParams();
    if (argv.workspace) params.append("workspace", "true");
    if (argv.platform) params.append("platform", "true");

    const serverUrl = `http://localhost:${argv.port}`;
    const response = await fetch(`${serverUrl}/library/templates?${params}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const templates = z.array(TemplateSchema).parse(data);

    s.stop("Templates fetched");

    if (argv.json) {
      console.log(
        JSON.stringify({ templates, count: templates.length }, null, 2),
      );
      return;
    }

    if (templates.length === 0) {
      console.log("No templates found");
      return;
    }

    render(<TemplatesDisplay templates={templates} />);
  } catch (error) {
    s.stop("Failed to fetch templates");
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

interface TemplatesDisplayProps {
  templates: Template[];
}

const TemplatesDisplay: React.FC<TemplatesDisplayProps> = ({ templates }) => {
  // Group templates by category
  const categorized = templates.reduce((acc, template) => {
    const category = template.category || "General";
    if (!acc[category]) acc[category] = [];
    acc[category].push(template);
    return acc;
  }, {} as Record<string, Template[]>);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Available Templates ({templates.length})</Text>
      </Box>

      <Table
        columns={[
          { key: "ID", label: "ID", width: 15 },
          { key: "Name", label: "Name", width: 20 },
          { key: "Format", label: "Format", width: 10 },
          { key: "Engine", label: "Engine", width: 12 },
          { key: "Description", label: "Description", width: 30 },
        ]}
        data={templates.map((template) => ({
          ID: template.id,
          Name: template.name,
          Format: template.format,
          Engine: template.engine,
          Description: template.description || "No description",
        }))}
      />

      <Box marginTop={1}>
        <Text dimColor>
          Use 'atlas library generate &lt;template-id&gt; &lt;data-file&gt;' to generate content
        </Text>
      </Box>

      {Object.keys(categorized).length > 1 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>By Category:</Text>
          {Object.entries(categorized).map(([category, items]) => (
            <Box key={category} marginLeft={2}>
              <Text>
                • {category}: {items.length} templates
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
