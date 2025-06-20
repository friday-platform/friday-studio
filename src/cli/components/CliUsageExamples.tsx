import { Box, Text } from "ink";

interface CliUsageExamplesProps {
  signal: Record<string, unknown>;
}

// Generate realistic example values based on property names and types
const generateExampleValue = (
  name: string,
  type: string,
  description?: string
): unknown => {
  const lowerName = name.toLowerCase();
  const lowerDesc = description?.toLowerCase() || "";

  switch (type) {
    case "string":
      if (lowerName.includes("path") || lowerDesc.includes("path")) {
        return "/tmp/example.txt";
      }
      if (lowerName.includes("url") || lowerDesc.includes("url")) {
        return "https://example.com";
      }
      if (lowerName.includes("message") || lowerDesc.includes("message")) {
        return "Hello World";
      }
      if (lowerName.includes("operation") || lowerDesc.includes("operation")) {
        return "read";
      }
      if (lowerName.includes("name") || lowerDesc.includes("name")) {
        return "example";
      }
      if (lowerName.includes("email") || lowerDesc.includes("email")) {
        return "user@example.com";
      }
      if (lowerName.includes("content") || lowerDesc.includes("content")) {
        return "Sample content";
      }
      if (lowerName.includes("encoding") || lowerDesc.includes("encoding")) {
        return "utf-8";
      }
      return "example_value";

    case "number":
      if (lowerName.includes("count") || lowerDesc.includes("count")) {
        return 5;
      }
      if (lowerName.includes("size") || lowerDesc.includes("size")) {
        return 1024;
      }
      if (lowerName.includes("timeout") || lowerDesc.includes("timeout")) {
        return 30000;
      }
      return 42;

    case "boolean":
      if (lowerName.includes("enabled") || lowerDesc.includes("enabled")) {
        return true;
      }
      if (lowerName.includes("recursive") || lowerDesc.includes("recursive")) {
        return false;
      }
      return true;

    case "array":
      return ["item1", "item2", "item3"];

    case "object":
      return {};

    default:
      return "unknown";
  }
};

// Generate example payload from schema for JSON format
const generateSchemaExample = (schema: Record<string, unknown>): unknown => {
  if (schema.type !== "object" || !schema.properties) {
    return {};
  }

  const properties = schema.properties as Record<
    string,
    Record<string, unknown>
  >;
  const required = (schema.required as string[]) || [];
  const example: Record<string, unknown> = {};

  // Add required fields first
  for (const fieldName of required) {
    const prop = properties[fieldName];
    if (prop) {
      let value = generateExampleValue(
        fieldName,
        prop.type as string,
        prop.description as string
      );

      // Handle enum values - pick the first one
      if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
        value = prop.enum[0];
      }

      example[fieldName] = value;
    }
  }

  // Add a few optional fields for demonstration
  const optionalFields = Object.keys(properties).filter(
    (key) => !required.includes(key)
  );
  const fieldsToShow = optionalFields.slice(0, 2); // Show up to 2 optional fields

  for (const fieldName of fieldsToShow) {
    const prop = properties[fieldName];
    if (prop) {
      let value = generateExampleValue(
        fieldName,
        prop.type as string,
        prop.description as string
      );

      // Handle enum values - pick the first one
      if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
        value = prop.enum[0];
      }

      example[fieldName] = value;
    }
  }

  return example;
};

// Convert value to CLI flag format
const formatFlagValue = (key: string, value: unknown): string[] => {
  const flags: string[] = [];

  if (Array.isArray(value)) {
    // Multiple flags for arrays: --tag item1 --tag item2
    value.forEach((item) => {
      flags.push(`--${key} ${String(item)}`);
    });
  } else if (typeof value === "boolean") {
    // Boolean format: --enabled true
    flags.push(`--${key} ${value}`);
  } else if (typeof value === "string") {
    // String format: --name "value"
    flags.push(`--${key} "${value}"`);
  } else {
    // Number and other types: --count 42
    flags.push(`--${key} ${String(value)}`);
  }

  return flags;
};

// Generate flag-based command from schema
const generateFlagCommand = (
  commandName: string,
  schema: Record<string, unknown>,
  requiredOnly = false
): string[] => {
  if (schema.type !== "object" || !schema.properties) {
    return [`atlas signal trigger ${commandName}`];
  }

  const properties = schema.properties as Record<
    string,
    Record<string, unknown>
  >;
  const required = (schema.required as string[]) || [];
  const lines: string[] = [];

  // Start with base command
  lines.push(`atlas signal trigger ${commandName} \\`);

  const fieldsToProcess = requiredOnly
    ? required
    : [
        ...required,
        ...Object.keys(properties)
          .filter((key) => !required.includes(key))
          .slice(0, 2),
      ];

  fieldsToProcess.forEach((fieldName, index) => {
    const prop = properties[fieldName];
    if (prop) {
      let value = generateExampleValue(
        fieldName,
        prop.type as string,
        prop.description as string
      );

      // Handle enum values - pick the first one
      if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
        value = prop.enum[0];
      }

      const flagValues = formatFlagValue(fieldName, value);

      flagValues.forEach((flagLine, flagIndex) => {
        const isLastFlag =
          index === fieldsToProcess.length - 1 &&
          flagIndex === flagValues.length - 1;
        if (isLastFlag) {
          lines.push(`  ${flagLine}`);
        } else {
          lines.push(`  ${flagLine} \\`);
        }
      });
    }
  });

  return lines;
};

export const CliUsageExamples = ({ signal }: CliUsageExamplesProps) => {
  // Determine command name: use signal.command if available, otherwise signal name
  const commandName =
    (signal.command as string) || (signal.name as string) || "signal-name";

  const schema = signal.schema as Record<string, unknown> | undefined;

  // If no schema, just show basic trigger command
  if (!schema || schema.type !== "object" || !schema.properties) {
    return (
      <Box flexDirection="column" marginBottom={2}>
        <Box marginBottom={1}>
          <Text bold>Usage Examples:</Text>
        </Box>

        <Box flexDirection="column">
          <Text dimColor>Atlas CLI command:</Text>
          <Text>atlas signal trigger {commandName}</Text>
        </Box>
      </Box>
    );
  }

  const properties = schema.properties as Record<string, unknown>;
  const required = (schema.required as string[]) || [];
  const hasRequiredFields = required.length > 0;
  const hasOptionalFields = Object.keys(properties).length > required.length;

  // Generate commands
  const minimalCommand = hasRequiredFields
    ? generateFlagCommand(commandName, schema, true)
    : [`atlas signal trigger ${commandName}`];

  const fullCommand = generateFlagCommand(commandName, schema, false);
  const exampleData = generateSchemaExample(schema);

  return (
    <Box flexDirection="column" marginBottom={2}>
      <Box marginBottom={1}>
        <Text bold>Usage Examples:</Text>
      </Box>

      {/* Minimal command (required fields only) */}
      {hasRequiredFields && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Minimal (required fields only):</Text>
          {minimalCommand.map((line, index) => (
            <Box flexShrink={0}>
              <Text key={index}>{line}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Full command (with optional fields) */}
      {hasOptionalFields && hasRequiredFields && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Full example (with optional fields):</Text>
          {fullCommand.map((line, index) => (
            <Box flexShrink={0}>
              <Text key={index}>{line}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* If no required fields, just show the full example */}
      {!hasRequiredFields && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Flag-based format:</Text>
          {fullCommand.map((line, index) => (
            <Box flexShrink={0}>
              <Text key={index}>{line}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* JSON format alternative */}
      {Object.keys(exampleData).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>JSON format alternative:</Text>
          <Text>atlas signal trigger {commandName} \</Text>
          <Text>--data '{JSON.stringify(exampleData, null, 2)}'</Text>
        </Box>
      )}
    </Box>
  );
};
