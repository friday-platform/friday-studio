import { getAtlasClient } from "@atlas/client";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { z } from "zod/v4";
import { checkDaemonRunning } from "../utils/daemon-client.ts";
import { MarkdownDisplay } from "./markdown-display.tsx";

interface SignalDetailsProps {
  workspaceId: string;
  signalId: string;
  workspacePath: string;
}

const appendSection = (markdown: string, title: string, content: string): string => {
  return `${markdown}## ${title}\n\n${content}\n\n`;
};

// Schema validation for signal schemas
const SignalSchemaValidator = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
});

type SignalSchema = z.infer<typeof SignalSchemaValidator>;

interface PropertyInfo {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  items?: PropertyInfo;
  properties?: PropertyInfo[];
  enum?: string[];
  default?: unknown;
}

// Helper function to validate and parse signal schema
const validateSignalSchema = (schema: unknown): SignalSchema | null => {
  try {
    return SignalSchemaValidator.parse(schema);
  } catch {
    return null;
  }
};

// Helper function to parse properties recursively
const parseProperty = (
  name: string,
  prop: Record<string, unknown>,
  required: string[] = [],
): PropertyInfo => {
  const isRequired = required.includes(name);

  if (prop.type === "object" && prop.properties) {
    return {
      name,
      type: "object",
      description: prop.description,
      required: isRequired,
      properties: Object.entries(prop.properties).map(([propName, propDef]) =>
        parseProperty(propName, propDef, prop.required || []),
      ),
    };
  } else if (prop.type === "array" && prop.items) {
    return {
      name,
      type: "array",
      description: prop.description,
      required: isRequired,
      items: parseProperty("item", prop.items),
    };
  } else {
    return {
      name,
      type: prop.type || "unknown",
      description: prop.description,
      required: isRequired,
      enum: prop.enum | undefined,
      default: prop.default,
    };
  }
};

// Helper functions to build markdown for different provider types
const buildHttpConfigMarkdown = (signal: Record<string, unknown>): string => {
  let content = "";
  const method = signal.method || "GET";
  const path = signal.path || signal.endpoint || "/";
  const headers = signal.headers || {};
  const config = signal.config || {};

  content += `Method: ${method}\n`;
  content += `Path: ${path}\n`;

  if (Object.keys(headers).length > 0) {
    content += "\n**Headers:**\n";
    Object.entries(headers).forEach(([key, value]) => {
      content += `- ${key}: ${value}\n`;
    });
  }

  if (signal.webhook_secret) {
    content += "\nSecurity: Webhook signature validation enabled\n";
  }

  if (config.timeout_ms) {
    content += `Timeout: ${String(config.timeout_ms)}ms\n`;
  }

  if (config.retry_config) {
    content += "\n**Retry Configuration:**\n";
    content += `- Max retries: ${config.retry_config.max_retries || "N/A"}\n`;
    content += `- Retry delay: ${config.retry_config.retry_delay_ms || "N/A"}ms\n`;
  }

  return content;
};

const buildCliConfigMarkdown = (signal: Record<string, unknown>): string => {
  let content = "";
  const command = signal.command || "";
  const args = signal.args || [];
  const flags = signal.flags || {};

  content += `Command: ${command}\n`;

  if (args.length > 0) {
    content += "\n**Arguments:**\n";
    args.forEach((arg, index) => {
      content += `- [${index}] ${arg}\n`;
    });
  }

  if (Object.keys(flags).length > 0) {
    content += "\n**Available Flags:**\n";
    Object.entries(flags).forEach(([flag, description]) => {
      content += `- --${flag}: ${String(description)}\n`;
    });
  }

  return content;
};

const buildSpecializedConfigMarkdown = (
  signal: Record<string, unknown>,
  provider: string,
): string => {
  let content = "";
  const config = signal.config || {};

  if (provider === "k8s-events") {
    if (signal.kubeconfig) {
      content += `Kubeconfig: ${signal.kubeconfig}\n`;
    }
    if (signal.namespace) {
      content += `Namespace: ${signal.namespace}\n`;
    }
    if (signal.insecure) {
      content += "Mode: Insecure (development)\n";
    }
  }

  if (provider === "http-webhook") {
    if (signal.endpoint) {
      content += `Endpoint: ${signal.endpoint}\n`;
    }
    if (config.webhook_secret) {
      content += "Security: Webhook secret configured\n";
    }
    if (config.allowed_event_types) {
      content += "\n**Allowed Events:**\n";
      config.allowed_event_types.forEach((eventType) => {
        content += `- ${eventType}\n`;
      });
    }
  }

  if (signal.timeout_ms) {
    content += `Timeout: ${String(signal.timeout_ms)}ms\n`;
  }

  return content;
};

const buildSchemaMarkdown = (properties: PropertyInfo[]): string => {
  let content = "";

  const renderProperty = (property: PropertyInfo, level = 0): string => {
    const indent = "  ".repeat(level);
    let propContent = "";

    propContent += `${indent}- **${property.name}** (${property.type})${
      property.required ? " *" : ""
    }\n`;

    if (property.description) {
      propContent += `${indent}  ${property.description}\n`;
    }

    if (property.enum) {
      propContent += `${indent}  Options: ${property.enum.join(", ")}\n`;
    }

    if (property.default !== undefined) {
      propContent += `${indent}  Default: ${String(property.default)}\n`;
    }

    if (property.type === "array" && property.items) {
      propContent += `${indent}  **Items:**\n`;
      propContent += renderProperty(property.items, level + 1);
    }

    if (property.properties) {
      property.properties.forEach((prop) => {
        propContent += renderProperty(prop, level + 1);
      });
    }

    return propContent;
  };

  properties.forEach((property) => {
    content += renderProperty(property);
  });

  return content;
};

export const SignalDetails = ({ workspaceId, signalId, workspacePath }: SignalDetailsProps) => {
  const [signalData, setSignalData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const loadSignalDetails = async () => {
      try {
        if (await checkDaemonRunning()) {
          const client = getAtlasClient();

          // Workspace path must be provided - no fallbacks to avoid validation issues
          if (!workspacePath) {
            throw new Error("Workspace path is required for signal details");
          }

          // Use the new client package method that avoids agent validation
          const signalDetails = await client.describeSignal(workspaceId, signalId, workspacePath);

          setSignalData(signalDetails);
        } else {
          setError("Daemon not running. Use 'atlas daemon start' to enable signal management.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    loadSignalDetails();
  }, [workspaceId, signalId]);

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Loading signal details...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (!signalData) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No signal data found</Text>
      </Box>
    );
  }

  // Build markdown content
  let markdown = `# ${signalId}\n\n`;

  if (signalData.description) {
    markdown += `${signalData.description}\n`;
  }

  // Provider
  const provider = signalData.provider;
  markdown += `Provider: ${provider || "Unknown"}\n\n`;

  // Provider-specific configuration
  if (provider === "http" || provider === "http-webhook") {
    const configContent = buildHttpConfigMarkdown(signalData);
    if (configContent) {
      markdown = appendSection(markdown, "HTTP Configuration", configContent);
    }
  } else if (provider === "cli") {
    const configContent = buildCliConfigMarkdown(signalData);
    if (configContent) {
      markdown = appendSection(markdown, "CLI Configuration", configContent);
    }
  } else if (
    provider &&
    ["k8s-events", "http-webhook", "codebase-watcher", "cron"].includes(provider)
  ) {
    const configContent = buildSpecializedConfigMarkdown(signalData, provider);
    if (configContent) {
      markdown = appendSection(markdown, "Configuration", configContent);
    }
  }

  // Schema Documentation
  if (signalData.schema) {
    const validatedSchema = validateSignalSchema(signalData.schema);
    if (validatedSchema) {
      const properties = Object.entries(validatedSchema.properties).map(([name, prop]) =>
        parseProperty(name, prop, validatedSchema.required || []),
      );

      const schemaContent = buildSchemaMarkdown(properties);
      if (schemaContent) {
        let finalSchemaContent = schemaContent;
        if (validatedSchema.required && validatedSchema.required.length > 0) {
          finalSchemaContent += "\n* Required fields";
        }
        markdown = appendSection(markdown, "Schema Documentation", finalSchemaContent);
      }
    } else {
      markdown = appendSection(
        markdown,
        "Schema Documentation",
        'Invalid schema format - must be type "object"',
      );
    }
  }

  // Raw Configuration (fallback for unknown providers)
  if (
    signalData.config &&
    !["http", "http-webhook", "cli", "k8s-events", "codebase-watcher", "cron"].includes(provider)
  ) {
    const rawConfig = JSON.stringify(signalData.config, null, 2);
    markdown = appendSection(markdown, "Raw Configuration", `\`\`\`\n${rawConfig}\n\`\`\``);
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <MarkdownDisplay markdown={markdown} />
    </Box>
  );
};
