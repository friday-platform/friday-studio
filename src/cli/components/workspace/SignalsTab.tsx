import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { z } from "zod/v4";
import { WorkspaceConfig } from "@atlas/config";
import { useActiveFocus, useTabNavigation } from "../tabs.tsx";
import { HttpUsageExamples } from "../HttpUsageExamples.tsx";
import { CliUsageExamples } from "../CliUsageExamples.tsx";
import { SidebarWrapper } from "../SidebarWrapper.tsx";
import { Select, TextInput } from "@inkjs/ui";
import { getAtlasClient } from "@atlas/client";

interface SignalsTabProps {
  config: WorkspaceConfig;
}

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

interface FormData {
  [key: string]: string;
}

interface SignalFormProps {
  signal: Record<string, unknown>;
  signalName: string;
  onSubmit: (data: Record<string, unknown>) => void;
  onCancel: () => void;
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
      description: prop.description as string | undefined,
      required: isRequired,
      properties: Object.entries(
        prop.properties as Record<string, unknown>,
      ).map(([propName, propDef]) =>
        parseProperty(
          propName,
          propDef as Record<string, unknown>,
          (prop.required as string[]) || [],
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
      enum: prop.enum as string[] | undefined,
      default: prop.default,
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

      {property.enum && (
        <Box marginLeft={level * 2}>
          <Text color="cyan">Options: {property.enum.join(", ")}</Text>
        </Box>
      )}

      {property.default !== undefined && (
        <Box marginLeft={level * 2}>
          <Text color="gray">Default: {String(property.default)}</Text>
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

// Signal Form Component
const SignalForm = ({ signal, signalName, onSubmit, onCancel }: SignalFormProps) => {
  const [formData, setFormData] = useState<FormData>({});
  const [currentField, setCurrentField] = useState(0);
  const [formFields, setFormFields] = useState<PropertyInfo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    // Parse schema to get form fields
    const validatedSchema = validateSignalSchema((signal as any).schema);
    if (validatedSchema) {
      const properties = Object.entries(validatedSchema.properties).map(([name, prop]) =>
        parseProperty(name, prop as Record<string, unknown>, validatedSchema.required || [])
      );
      setFormFields(properties);

      // Initialize form data with defaults or empty strings
      const initialData: FormData = {};
      properties.forEach((prop) => {
        if (prop.enum && prop.default !== undefined) {
          initialData[prop.name] = String(prop.default);
        } else if (prop.enum && prop.enum.length > 0) {
          initialData[prop.name] = prop.enum[0]; // Default to first enum value
        } else {
          initialData[prop.name] = "";
        }
      });
      setFormData(initialData);
    }
  }, [signal]);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");

    try {
      // Convert form data to proper types based on schema
      const processedData: Record<string, unknown> = {};

      formFields.forEach((field) => {
        const value = formData[field.name];
        if (value.trim() === "" && !field.required) {
          return; // Skip empty optional fields
        }

        switch (field.type) {
          case "number":
            processedData[field.name] = parseFloat(value);
            break;
          case "boolean":
            processedData[field.name] = value.toLowerCase() === "true";
            break;
          case "object":
            try {
              processedData[field.name] = JSON.parse(value || "{}");
            } catch {
              throw new Error(`Invalid JSON for field ${field.name}`);
            }
            break;
          case "array":
            try {
              processedData[field.name] = JSON.parse(value || "[]");
            } catch {
              throw new Error(`Invalid JSON array for field ${field.name}`);
            }
            break;
          default:
            processedData[field.name] = value;
        }
      });

      // Validate required fields
      const missingRequired = formFields
        .filter((field) => field.required && !processedData.hasOwnProperty(field.name))
        .map((field) => field.name);

      if (missingRequired.length > 0) {
        throw new Error(`Required fields missing: ${missingRequired.join(", ")}`);
      }

      await onSubmit(processedData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  useInput((inputChar, key) => {
    if (submitting) return;

    if (key.tab) {
      setCurrentField((prev) => (prev + 1) % (formFields.length + 2)); // +2 for submit/cancel buttons
    } else if (key.upArrow) {
      setCurrentField((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setCurrentField((prev) => Math.min(formFields.length + 1, prev + 1));
    } else if (key.return) {
      if (currentField === formFields.length) {
        handleSubmit();
      } else if (currentField === formFields.length + 1) {
        onCancel();
      }
    } else if (key.escape) {
      onCancel();
    }
  });

  if (formFields.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="red">No schema defined for this signal. Cannot create form.</Text>
        <Box marginTop={1}>
          <Text color="gray">Press ESC to cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor="cyan">
      <Box marginBottom={1}>
        <Text bold color="cyan">Send Signal: {signalName}</Text>
      </Box>

      {error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {/* Form Fields */}
      {formFields.map((field, index) => (
        <Box key={field.name} marginBottom={1} flexDirection="column">
          <Box>
            <Text color={currentField === index ? "cyan" : "white"}>
              {currentField === index ? "❯ " : "  "}
              {field.name}
              {field.required && <Text color="red">*</Text>}
              <Text dimColor>({field.enum ? "enum" : field.type})</Text>
            </Text>
          </Box>
          {field.description && (
            <Box marginLeft={2}>
              <Text color="gray">{field.description}</Text>
            </Box>
          )}
          <Box marginLeft={2}>
            {currentField === index
              ? (
                field.enum
                  ? (
                    <Select
                      options={field.enum.map((value) => ({
                        label: value,
                        value: value,
                      }))}
                      onChange={(value) => {
                        setFormData((prev) => ({ ...prev, [field.name]: value }));
                        setCurrentField((prev) => Math.min(formFields.length + 1, prev + 1));
                      }}
                      isDisabled={false}
                    />
                  )
                  : (
                    <TextInput
                      placeholder={field.type === "object"
                        ? "{}"
                        : field.type === "array"
                        ? "[]"
                        : `Enter ${field.name}`}
                      onSubmit={(value) => {
                        setFormData((prev) => ({ ...prev, [field.name]: value }));
                        setCurrentField((prev) => Math.min(formFields.length + 1, prev + 1));
                      }}
                    />
                  )
              )
              : <Text dimColor>{formData[field.name] || `<enter ${field.name}>`}</Text>}
          </Box>
        </Box>
      ))}

      {/* Action Buttons */}
      <Box marginTop={1} flexDirection="row" gap={4}>
        <Box>
          <Text
            color={currentField === formFields.length ? "cyan" : "green"}
            bold={currentField === formFields.length}
          >
            {currentField === formFields.length ? "❯ " : "  "}
            {submitting ? "Sending..." : "Send Signal"}
          </Text>
        </Box>
        <Box>
          <Text
            color={currentField === formFields.length + 1 ? "cyan" : "red"}
            bold={currentField === formFields.length + 1}
          >
            {currentField === formFields.length + 1 ? "❯ " : "  "}
            Cancel
          </Text>
        </Box>
      </Box>

      <Box marginTop={2}>
        <Text color="gray">
          Use Tab/Arrow keys to navigate, Enter to select, ESC to cancel
        </Text>
      </Box>
    </Box>
  );
};

export const SignalsTab = ({ config }: SignalsTabProps) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [submissionResult, setSubmissionResult] = useState<string>("");

  const signals = config.signals ? Object.entries(config.signals) : [];

  // Use active focus to switch between sidebar, main area, and form
  const { activeArea } = useActiveFocus({
    areas: showForm ? ["form"] : ["sidebar", "main"],
    initialArea: 0,
  });

  const isSidebarActive = activeArea === 0 && !showForm;
  const isMainActive = activeArea === 1 && !showForm;
  const isFormActive = showForm;

  // Use tab navigation for signals with arrow key support when sidebar is active
  const { activeTab: selectedSignalIndex } = useTabNavigation({
    tabCount: signals.length,
    initialTab: 0,
    useArrowKeys: true,
    isActive: isSidebarActive,
  });

  const selectedSignal = signals.length > 0 ? signals[selectedSignalIndex][0] : null;
  const selectedSignalData = selectedSignal && config.signals
    ? config.signals[selectedSignal]
    : null;

  // Signal submission function
  const handleSignalSubmit = async (data: Record<string, unknown>) => {
    if (!selectedSignal) return;

    try {
      const port = 8080; // Default workspace server port
      const client = getAtlasClient();

      // Use the workspace signal trigger method
      await client.triggerWorkspaceSignal(port, selectedSignal, data);

      setSubmissionResult(`Signal '${selectedSignal}' triggered successfully!`);
      setShowForm(false);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Failed to connect")) {
        setSubmissionResult(
          `Cannot connect to workspace server on port 8080. Is it running? Use 'atlas workspace serve' to start it.`,
        );
      } else {
        setSubmissionResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      setShowForm(false);
    }
  };

  const handleFormCancel = () => {
    setShowForm(false);
  };

  // Handle keyboard navigation for scrolling when main area is active
  useInput((inputChar, key) => {
    if (showForm) {
      // Form handles its own input
      return;
    }

    if (isMainActive) {
      const scrollAmount = key.shift ? 10 : 1; // 10x faster scrolling with Shift

      if (key.upArrow || inputChar === "k") {
        setScrollOffset((prev) => Math.min(0, prev + scrollAmount)); // Max value 0 (can't scroll up past top)
      } else if (key.downArrow || inputChar === "j") {
        setScrollOffset((prev) => prev - scrollAmount); // No limit (can scroll down indefinitely)
      } else if (inputChar === "s" && selectedSignalData && (selectedSignalData as any).schema) {
        // Press 's' to show signal form
        setShowForm(true);
        setSubmissionResult("");
      }

      // Handle vim keys with shift modifier for fast scrolling
      if (inputChar === "K") {
        // Shift+k = fast scroll up
        setScrollOffset((prev) => Math.min(0, prev + 10));
      } else if (inputChar === "J") {
        // Shift+j = fast scroll down
        setScrollOffset((prev) => prev - 10);
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

  // Show form overlay if form is active
  if (showForm && selectedSignalData && selectedSignal) {
    return (
      <SignalForm
        signal={selectedSignalData as Record<string, unknown>}
        signalName={selectedSignal}
        onSubmit={handleSignalSubmit}
        onCancel={handleFormCancel}
      />
    );
  }

  return (
    <Box flexDirection="row" height="100%" width="100%">
      {/* Sidebar */}
      <SidebarWrapper isActive={isSidebarActive}>
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
      </SidebarWrapper>

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
        {selectedSignalData
          ? (
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

              {/* Show submission result if available */}
              {submissionResult && (
                <Box
                  marginBottom={2}
                  padding={1}
                  borderStyle="round"
                  borderColor={submissionResult.includes("Error") ? "red" : "green"}
                >
                  <Text color={submissionResult.includes("Error") ? "red" : "green"}>
                    {submissionResult}
                  </Text>
                </Box>
              )}

              {/* Show form availability hint */}
              {(selectedSignalData as any).schema && (
                <Box marginBottom={1}>
                  <Text color="cyan">
                    ⌨️ Press 's' to send this signal
                  </Text>
                </Box>
              )}

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
                    (selectedSignalData as any).schema,
                  );
                  if (validatedSchema) {
                    const properties = Object.entries(
                      validatedSchema.properties,
                    ).map(([name, prop]) =>
                      parseProperty(
                        name,
                        prop as Record<string, unknown>,
                        validatedSchema.required || [],
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
                      2,
                    )}
                  </Text>
                </Box>
              )}
            </Box>
          )
          : (
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
