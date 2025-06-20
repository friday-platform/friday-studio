import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { z } from "zod";
import { WorkspaceConfig } from "../../utils/workspace-loader.ts";
import { useTabNavigation, useActiveFocus } from "../tabs.tsx";
import { HttpUsageExamples } from "../HttpUsageExamples.tsx";
import { CliUsageExamples } from "../CliUsageExamples.tsx";

interface SignalsTabProps {
  config: WorkspaceConfig;
}

// Schema validation for signal schemas
const SignalSchemaValidator = z.object({
  type: z.literal("object"),
  properties: z.record(z.unknown()),
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
  required: string[] = []
): PropertyInfo => {
  const isRequired = required.includes(name);

  if (prop.type === "object" && prop.properties) {
    return {
      name,
      type: "object",
      description: prop.description as string | undefined,
      required: isRequired,
      properties: Object.entries(
        prop.properties as Record<string, unknown>
      ).map(([propName, propDef]) =>
        parseProperty(
          propName,
          propDef as Record<string, unknown>,
          (prop.required as string[]) || []
        )
      ),
    };
  } else if (prop.type === "array" && prop.items) {
    return {
      name,
      type: "array",
      description: prop.description as string | undefined,
      required: isRequired,
      items: parseProperty("item", prop.items as Record<string, unknown>),
    };
  } else {
    return {
      name,
      type: (prop.type as string) || "unknown",
      description: prop.description as string | undefined,
      required: isRequired,
    };
  }
};

// Component to render property documentation with enhanced visual styling
const PropertyDoc = ({
  property,
  level = 0,
}: {
  property: PropertyInfo;
  level?: number;
}) => {
  const indent = "  ".repeat(level);

  // Get color for type badge based on type
  const getTypeColor = (type: string) => {
    switch (type) {
      case "string":
        return "blue";
      case "number":
        return "green";
      case "boolean":
        return "yellow";
      case "object":
        return "magenta";
      case "array":
        return "cyan";
      default:
        return "gray";
    }
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">
          {indent}
          {property.name}
        </Text>
        <Text color={getTypeColor(property.type)} dimColor>
          ({property.type})
        </Text>
        {property.required && <Text color="red">*</Text>}
      </Box>

      {property.description && (
        <Box marginLeft={level * 2}>
          <Text color="yellow">{property.description}</Text>
        </Box>
      )}

      {property.type === "array" && property.items && (
        <Box marginLeft={level * 2}>
          <Text color="gray">Items:</Text>
          <PropertyDoc property={property.items} level={level + 1} />
        </Box>
      )}

      {property.properties && (
        <Box flexDirection="column" marginLeft={level * 2}>
          {property.properties.map((prop) => (
            <PropertyDoc key={prop.name} property={prop} level={level + 1} />
          ))}
        </Box>
      )}
    </Box>
  );
};

// HTTP Signal provider-specific display
const HttpSignalDetails = ({ signal }: { signal: Record<string, unknown> }) => {
  const method = (signal.method as string) || "GET";
  const path = (signal.path as string) || (signal.endpoint as string) || "/";
  const headers = (signal.headers as Record<string, string>) || {};
  const config = (signal.config as Record<string, unknown>) || {};

  return (
    <Box flexDirection="column" marginBottom={2}>
      <Box marginBottom={1}>
        <Text bold>HTTP Configuration:</Text>
      </Box>

      <Box>
        <Text dimColor>Method:</Text>
        <Text>{method}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Path:</Text>
        <Text>{path}</Text>
      </Box>

      {Object.keys(headers).length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan">Headers:</Text>
          {Object.entries(headers).map(([key, value]) => (
            <Box key={key} marginLeft={2}>
              <Text color="gray">{key}:</Text>
              <Text color="white">{value}</Text>
            </Box>
          ))}
        </Box>
      )}

      {signal.webhook_secret && (
        <Box marginBottom={1}>
          <Text dimColor>Security:</Text>
          <Text>Webhook signature validation enabled</Text>
        </Box>
      )}

      {config.timeout_ms && (
        <Box marginBottom={1}>
          <Text dimColor>Timeout:</Text>
          <Text>{String(config.timeout_ms)}ms</Text>
        </Box>
      )}

      {config.retry_config && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Retry Configuration:</Text>
          <Box marginLeft={2}>
            <Text dimColor>Max retries:</Text>
            <Text>{(config.retry_config as any).max_retries || "N/A"}</Text>
          </Box>
          <Box marginLeft={2}>
            <Text dimColor>Retry delay:</Text>
            <Text>
              {(config.retry_config as any).retry_delay_ms || "N/A"}ms
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

// CLI Signal provider-specific display
const CliSignalDetails = ({ signal }: { signal: Record<string, unknown> }) => {
  const command = (signal.command as string) || "";
  const args = (signal.args as string[]) || [];
  const flags = (signal.flags as Record<string, unknown>) || {};

  return (
    <Box flexDirection="column" marginBottom={2}>
      <Box marginBottom={1}>
        <Text bold color="green">
          CLI Configuration:
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Command:</Text>
        <Text>{command}</Text>
      </Box>

      {args.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Arguments:</Text>
          {args.map((arg, index) => (
            <Box key={index} marginLeft={2}>
              <Text dimColor>[{index}]</Text>
              <Text>{arg}</Text>
            </Box>
          ))}
        </Box>
      )}

      {Object.keys(flags).length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan">Available Flags:</Text>
          {Object.entries(flags).map(([flag, description]) => (
            <Box key={flag} marginLeft={2}>
              <Text color="yellow">--{flag}:</Text>
              <Text color="gray">{String(description)}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

// Specialized provider display (k8s-events, webhooks, etc.)
const SpecializedProviderDetails = ({
  signal,
  provider,
}: {
  signal: Record<string, unknown>;
  provider: string;
}) => {
  const config = (signal.config as Record<string, unknown>) || {};

  return (
    <Box flexDirection="column" marginBottom={2}>
      <Box marginBottom={1}>
        <Text bold>Configuration:</Text>
      </Box>

      {provider === "k8s-events" && (
        <>
          {signal.kubeconfig && (
            <Box marginBottom={1}>
              <Text dimColor>Kubeconfig:</Text>
              <Text>{signal.kubeconfig as string}</Text>
            </Box>
          )}
          {signal.namespace && (
            <Box marginBottom={1}>
              <Text dimColor>Namespace:</Text>
              <Text>{signal.namespace as string}</Text>
            </Box>
          )}
          {signal.insecure && (
            <Box marginBottom={1}>
              <Text dimColor>Mode:</Text>
              <Text>Insecure (development)</Text>
            </Box>
          )}
        </>
      )}

      {provider === "http-webhook" && (
        <>
          {signal.endpoint && (
            <Box marginBottom={1}>
              <Text dimColor>Endpoint:</Text>
              <Text>{signal.endpoint as string}</Text>
            </Box>
          )}
          {config.webhook_secret && (
            <Box marginBottom={1}>
              <Text dimColor>Security:</Text>
              <Text>Webhook secret configured</Text>
            </Box>
          )}
          {config.allowed_event_types && (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor>Allowed Events:</Text>
              {(config.allowed_event_types as string[]).map((eventType) => (
                <Box key={eventType} marginLeft={2}>
                  <Text dimColor>•</Text>
                  <Text color="white">{eventType}</Text>
                </Box>
              ))}
            </Box>
          )}
        </>
      )}

      {signal.timeout_ms && (
        <Box marginBottom={1}>
          <Text dimColor>Timeout:</Text>
          <Text>{String(signal.timeout_ms)}ms</Text>
        </Box>
      )}
    </Box>
  );
};

export const SignalsTab = ({ config }: SignalsTabProps) => {
  const [scrollOffset, setScrollOffset] = useState(0);

  const signals = config.signals ? Object.entries(config.signals) : [];

  // Use active focus to switch between sidebar and main area
  const { activeArea } = useActiveFocus({
    areas: ["sidebar", "main"],
    initialArea: 0,
  });

  const isSidebarActive = activeArea === 0;
  const isMainActive = activeArea === 1;

  // Use tab navigation for signals with arrow key support when sidebar is active
  const { activeTab: selectedSignalIndex } = useTabNavigation({
    tabCount: signals.length,
    initialTab: 0,
    useArrowKeys: true,
    isActive: isSidebarActive,
  });

  const selectedSignal =
    signals.length > 0 ? signals[selectedSignalIndex][0] : null;
  const selectedSignalData =
    selectedSignal && config.signals ? config.signals[selectedSignal] : null;

  // Handle keyboard navigation for scrolling when main area is active
  useInput((inputChar, key) => {
    if (isMainActive) {
      const scrollAmount = key.shift ? 10 : 1; // 10x faster scrolling with Shift

      if (key.upArrow) {
        setScrollOffset((prev) => Math.min(0, prev + scrollAmount)); // Max value 0 (can't scroll up past top)
      } else if (key.downArrow) {
        setScrollOffset((prev) => prev - scrollAmount); // No limit (can scroll down indefinitely)
      }
    }
  });

  if (!config.signals || signals.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="gray">No signals configured</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" height="100%" width="100%">
      {/* Sidebar */}
      <Box
        marginLeft={1}
        borderStyle={isSidebarActive ? "round" : undefined}
        borderColor="gray"
        borderDimColor
        padding={isSidebarActive ? 0 : 1}
        width="25%"
      >
        <Box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
          <Box flexDirection="column">
            {signals.map(([signalName], index) => (
              <Box key={signalName}>
                <Text
                  bold={index === selectedSignalIndex}
                  dimColor={index !== selectedSignalIndex}
                >
                  {index === selectedSignalIndex ? "❯ " : "  "}
                  {signalName}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      {/* Main Area */}
      <Box
        flexDirection="column"
        flexGrow={1}
        paddingX={isMainActive ? 2 : 3}
        paddingY={isMainActive ? 1 : 2}
        overflow="hidden"
        borderStyle={isMainActive ? "round" : undefined}
        borderColor="gray"
        borderDimColor
      >
        {selectedSignalData ? (
          <Box
            flexDirection="column"
            marginTop={scrollOffset}
            flexGrow={1}
            flexShrink={0}
          >
            <Box>
              <Text bold>{selectedSignal}</Text>
            </Box>
            {(selectedSignalData as any).description && (
              <Box marginBottom={1}>
                <Text dimColor>{(selectedSignalData as any).description}</Text>
              </Box>
            )}
            <Box marginBottom={1}>
              <Text dimColor>Provider:</Text>
              <Text>{(selectedSignalData as any).provider || "Unknown"}</Text>
            </Box>

            {/* Provider-Specific Details */}
            {(() => {
              const provider = (selectedSignalData as any).provider as string;

              if (provider === "http" || provider === "http-webhook") {
                return (
                  <>
                    <HttpSignalDetails
                      signal={selectedSignalData as Record<string, unknown>}
                    />
                    <HttpUsageExamples
                      signal={selectedSignalData as Record<string, unknown>}
                    />
                  </>
                );
              } else if (provider === "cli") {
                return (
                  <>
                    <CliSignalDetails
                      signal={selectedSignalData as Record<string, unknown>}
                    />
                    <CliUsageExamples
                      signal={selectedSignalData as Record<string, unknown>}
                    />
                  </>
                );
              } else if (
                provider &&
                [
                  "k8s-events",
                  "http-webhook",
                  "codebase-watcher",
                  "cron",
                ].includes(provider)
              ) {
                return (
                  <SpecializedProviderDetails
                    signal={selectedSignalData as Record<string, unknown>}
                    provider={provider}
                  />
                );
              }
              return null;
            })()}

            {/* Schema Documentation */}
            {(selectedSignalData as any).schema &&
              (() => {
                const validatedSchema = validateSignalSchema(
                  (selectedSignalData as any).schema
                );
                if (validatedSchema) {
                  const properties = Object.entries(
                    validatedSchema.properties
                  ).map(([name, prop]) =>
                    parseProperty(
                      name,
                      prop as Record<string, unknown>,
                      validatedSchema.required || []
                    )
                  );

                  return (
                    <Box flexDirection="column" marginTop={2}>
                      <Box marginBottom={1}>
                        <Text bold color="green">
                          Schema Documentation:
                        </Text>
                      </Box>
                      {properties.map((property) => (
                        <PropertyDoc key={property.name} property={property} />
                      ))}
                      {validatedSchema.required &&
                        validatedSchema.required.length > 0 && (
                          <Box marginTop={2}>
                            <Text color="red">* Required fields</Text>
                          </Box>
                        )}
                    </Box>
                  );
                } else {
                  return (
                    <Box marginTop={2}>
                      <Text color="red">
                        Invalid schema format - must be type "object"
                      </Text>
                    </Box>
                  );
                }
              })()}

            {/* Raw Configuration (fallback for unknown providers) */}
            {(selectedSignalData as any).config &&
              ![
                "http",
                "http-webhook",
                "cli",
                "k8s-events",
                "codebase-watcher",
                "cron",
              ].includes((selectedSignalData as any).provider as string) && (
                <Box marginTop={2}>
                  <Text bold>Raw Configuration:</Text>
                  <Text>
                    {JSON.stringify(
                      (selectedSignalData as any).config,
                      null,
                      2
                    )}
                  </Text>
                </Box>
              )}
          </Box>
        ) : (
          <Box
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            height="100%"
          >
            <Text color="gray">Select a signal to view details</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
