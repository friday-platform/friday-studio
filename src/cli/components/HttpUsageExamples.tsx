import { Box, Text } from "ink";

interface HttpUsageExamplesProps {
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
      return ["example_item"];

    case "object":
      return {};

    default:
      return "unknown";
  }
};

// Generate example payload from schema
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
      example[fieldName] = generateExampleValue(
        fieldName,
        prop.type as string,
        prop.description as string
      );
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
      example[fieldName] = generateExampleValue(
        fieldName,
        prop.type as string,
        prop.description as string
      );
    }
  }

  return example;
};

// Generate curl command
const generateCurlCommand = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
): string[] => {
  const lines: string[] = [];

  // Base curl command with method and URL
  lines.push(`curl -X ${method} http://localhost:8080${path} \\`);

  // Add Content-Type header for requests with body
  if (
    body !== undefined &&
    (method === "POST" || method === "PUT" || method === "PATCH")
  ) {
    lines.push(`  -H "Content-Type: application/json" \\`);
  }

  // Add configured headers
  Object.entries(headers).forEach(([key, value]) => {
    lines.push(`  -H "${key}: ${value}" \\`);
  });

  // Add body for non-GET requests
  if (body !== undefined && method !== "GET") {
    const bodyStr = JSON.stringify(body, null, 2);
    // Indent the body content
    const indentedBody = bodyStr
      .split("\n")
      .map((line) => `${line}`)
      .join("\n");

    lines.push(`  -d '${indentedBody}'`);
  } else {
    // Remove trailing backslash from last header
    if (lines.length > 0 && lines[lines.length - 1].endsWith(" \\")) {
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, -2);
    }
  }

  return lines;
};

export const HttpUsageExamples = ({ signal }: HttpUsageExamplesProps) => {
  const method = (signal.method as string) || "GET";
  const path = (signal.path as string) || (signal.endpoint as string) || "/";
  const headers = (signal.headers as Record<string, string>) || {};
  const schema = signal.schema as Record<string, unknown> | undefined;

  // Generate example payload
  let exampleBody: unknown = undefined;

  if (method !== "GET") {
    if (schema) {
      exampleBody = generateSchemaExample(schema);
    } else {
      exampleBody = {};
    }
  }

  const curlLines = generateCurlCommand(method, path, headers, exampleBody);

  return (
    <Box flexDirection="column" marginBottom={2}>
      <Box marginBottom={1}>
        <Text bold>Usage Examples:</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Curl command:</Text>
        {curlLines.map((line, index) => (
          <Text key={index}>{line}</Text>
        ))}
      </Box>

      {schema && Object.keys(generateSchemaExample(schema)).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Atlas CLI command:</Text>
          <Text>
            atlas signal trigger {String(signal.name) || "signal-name"} \
          </Text>
          <Text>--data '{JSON.stringify(exampleBody, null, 2)}'</Text>
        </Box>
      )}
    </Box>
  );
};
