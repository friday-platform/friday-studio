# Agent Conversion

Converts different agent formats to AtlasAgent instances. This is separate from agent loading - it
only handles format conversion, not discovery or caching.

## What It Does

- **YAML → SDK**: Converts .agent.yml files to AtlasAgent instances
- **LLM → SDK**: Converts workspace LLM configs to AtlasAgent instances
- **Validation**: Ensures all converted agents are valid
- **Tool Conversion**: Handles tool definitions across formats

## Why Separate from Agent Loader?

The agent loader handles discovery, caching, and registry. This module handles pure format
conversion:

```
Agent Loader: "Where do I find agents?" → AgentSourceData
Agent Conversion: "How do I convert this format?" → AtlasAgent
```

This separation makes it easy to add new agent formats without touching the loading logic.

## Key Files

### `from-yaml.ts`

Converts YAML agent definitions to SDK format:

```typescript
// Parse YAML content with environment variable interpolation
const yamlDef = parseYAMLAgentContent(content, {
  env: process.env,
  validateEnv: true,
});

// Convert to AtlasAgent
const agent = convertYAMLToAgent(yamlDef);
```

### `from-llm.ts`

Converts workspace LLM configurations to agents:

```typescript
// Convert workspace.yml LLM config to agent
const llmAgent = convertLLMConfigToAgent(
  workspaceConfig.llm,
  "workspace-llm-agent",
);
```

### `yaml/`

YAML-specific parsing and validation:

- **`parser.ts`**: Parses YAML content with environment variable interpolation
- **`schema.ts`**: Zod schemas for validating YAML structure

### `shared/`

Common conversion utilities:

- **`tool-converter.ts`**: Converts tool definitions between formats

## Usage in Agent Loader

The agent loader uses these converters when loading agents:

```typescript
// In AgentLoader.convertToSDKAgent()
switch (source.type) {
  case "yaml":
    const yamlDef = parseYAMLAgentContent(source.content!, options);
    return convertYAMLToAgent(yamlDef);

  case "system":
  case "bundled":
  case "sdk":
    // Already AtlasAgent instances
    return source.agent!;
}
```

## Usage in Session Runtime

LLM agents are created directly by the session runtime:

```typescript
// During session initialization
if (workspaceConfig.llm) {
  const llmAgent = convertLLMConfigToAgent(
    workspaceConfig.llm,
    "workspace-llm-agent",
  );

  // Use directly in this session only
  // Not registered in any loader
}
```

## Environment Variable Interpolation

YAML agents support environment variable interpolation:

```yaml
# In .agent.yml
agent:
  name: "Slack Bot"
  tools:
    - name: "post_message"
      config:
        api_key: "${SLACK_API_KEY}" # Interpolated at parse time
```

```typescript
// Parser validates required env vars are present
const yamlDef = parseYAMLAgentContent(content, {
  env: { SLACK_API_KEY: "xoxb-..." },
  validateEnv: true, // Throws if SLACK_API_KEY missing
});
```

## Adding New Formats

To add a new agent format:

1. Create `from-myformat.ts` with conversion functions
2. Add format-specific parsing in `myformat/` directory
3. Update agent loader to handle the new format
4. Add tests for conversion logic

Example structure:

```
agent-conversion/
├── from-myformat.ts          # Main conversion logic
├── myformat/
│   ├── parser.ts            # Format-specific parsing
│   └── schema.ts            # Validation schemas
└── tests/
    └── myformat.test.ts     # Conversion tests
```

## Validation

All converters use Zod schemas for validation:

```typescript
// YAML schema validates structure
const yamlSchema = z.object({
  agent: z.object({
    name: z.string(),
    description: z.string().optional(),
    tools: z.array(toolSchema).optional(),
  }),
});

// Parse and validate
const yamlDef = yamlSchema.parse(rawYaml);
```

## Error Handling

Converters throw descriptive errors for invalid input:

```typescript
try {
  const agent = convertYAMLToAgent(yamlDef);
} catch (error) {
  // Error includes context about what went wrong
  console.error(`YAML conversion failed: ${error.message}`);
}
```

## Testing

Run tests with:

```bash
deno task test packages/core/tests/agent-conversion
```

Tests cover:

- YAML parsing with various edge cases
- Environment variable interpolation
- LLM config conversion
- Tool definition conversion
- Schema validation
- Error handling

## Important Notes

- **Pure conversion only** - no discovery, caching, or registry logic
- **Environment variables** - YAML agents support ${VAR} interpolation
- **Validation is strict** - invalid formats throw errors immediately
- **LLM agents are ephemeral** - created per-session, not pre-registered
- **Tool conversion is shared** - common logic in `shared/tool-converter.ts`
