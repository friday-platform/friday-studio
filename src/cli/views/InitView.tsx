import process from "node:process";
import { defaultTheme, extendTheme, Spinner, TextInput, ThemeProvider } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useCallback, useState } from "react";
import { MultiSelect } from "../components/multi-select.tsx";
import { createAndRegisterWorkspace } from "../modules/workspaces/creator.ts";

// Custom theme with yellow highlights for Select and Spinner components
const customTheme = extendTheme(defaultTheme, {
  components: { Spinner: { styles: { frame: () => ({ color: "yellow" }) } } },
});

interface WorkspaceConfig {
  name: string;
  path: string;
  description: string;
  agents: string[];
  signals: string[];
}

interface InitViewProps {
  onExit: () => void;
}

const InitViewContent = ({ onExit }: InitViewProps) => {
  const [config, setConfig] = useState<WorkspaceConfig>({
    name: "",
    path: process.cwd(),
    description: "",
    agents: [],
    signals: ["cli"],
  });

  const [focusedField, setFocusedField] = useState<
    "name" | "path" | "description" | "agents" | "signals" | "submit" | "yes" | "no"
  >("name");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  useInput((_, key) => {
    if (key.escape) {
      onExit();
      return;
    }

    if (showSuccess && key.return) {
      onExit();
      return;
    }

    if (showConfirmation) {
      if (key.tab) {
        setFocusedField((prev) => (prev === "yes" ? "no" : "yes"));
        return;
      }
      if (key.return) {
        if (focusedField === "yes") {
          confirmCreate();
        } else {
          setShowConfirmation(false);
          setFocusedField("name");
        }
        return;
      }
    } else {
      if (key.tab) {
        setFocusedField((prev) => {
          if (prev === "name") return "path";
          if (prev === "path") return "description";
          if (prev === "description") return "agents";
          if (prev === "agents") return "signals";
          if (prev === "signals") return "submit";
          return "name";
        });
        return;
      }

      if (key.return && focusedField === "submit") {
        setShowConfirmation(true);
        setFocusedField("yes");
        return;
      }
    }
  });

  const confirmCreate = () => {
    setIsCreating(true);

    // Show spinner for 1 second
    setTimeout(async () => {
      await createWorkspace();
      setIsCreating(false);
      setShowSuccess(true);
    }, 1000);
  };

  const createWorkspace = async () => {
    await createAndRegisterWorkspace({
      name: config.name,
      path: config.path,
      description: config.description,
      agents: config.agents,
      signals: config.signals,
    });
  };

  const handleNameChange = useCallback((value: string) => {
    setConfig((prev) => ({ ...prev, name: value }));
  }, []);

  const handlePathChange = useCallback((value: string) => {
    setConfig((prev) => ({ ...prev, path: value }));
  }, []);

  const handleDescriptionChange = useCallback((value: string) => {
    setConfig((prev) => ({ ...prev, description: value }));
  }, []);

  const handleAgentsChange = useCallback((values: string[]) => {
    setConfig((prev) => ({ ...prev, agents: values }));
  }, []);

  const handleSignalsChange = useCallback((values: string[]) => {
    setConfig((prev) => ({ ...prev, signals: values }));
  }, []);

  if (showSuccess) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="green">
          Workspace created successfully!
        </Text>
        <Box marginTop={1}>
          <Text>Name: {config.name}</Text>
        </Box>
        <Box>
          <Text>Path: {config.path}/workspace.yml</Text>
        </Box>
        <Box marginTop={2}>
          <Text dimColor>Press Enter to continue...</Text>
        </Box>
      </Box>
    );
  }

  if (isCreating) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="row" alignItems="center">
          <Spinner type="dots" />
          <Text>Creating workspace...</Text>
        </Box>
      </Box>
    );
  }

  if (showConfirmation) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text bold>Review</Text>
        <Box marginTop={1}>
          <Text>Name: {config.name}</Text>
        </Box>
        <Box>
          <Text>Path: {config.path}</Text>
        </Box>
        <Box>
          <Text>Description: {config.description || "(none)"}</Text>
        </Box>
        <Box>
          <Text>Agents: {config.agents.length > 0 ? config.agents.join(", ") : "(none)"}</Text>
        </Box>
        <Box>
          <Text>Signals: {config.signals.length > 0 ? config.signals.join(", ") : "(none)"}</Text>
        </Box>

        <Box marginTop={2} flexDirection="row" gap={4}>
          <Text
            backgroundColor={focusedField === "yes" ? "yellow" : undefined}
            color={focusedField === "yes" ? "black" : "yellow"}
          >
            Create
          </Text>
          <Text
            backgroundColor={focusedField === "no" ? "red" : undefined}
            color={focusedField === "no" ? "black" : "red"}
          >
            Cancel
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <Box marginTop={1}>
        <Text dimColor>← Cancel [Escape]</Text>
      </Box>

      <Box marginTop={2}>
        <Text bold>Workspace name:</Text>
      </Box>

      <Box>
        <TextInput
          isDisabled={focusedField !== "name"}
          placeholder="Enter name here..."
          onChange={handleNameChange}
          defaultValue={config.name}
        />
      </Box>

      <Box marginTop={2}>
        <Text bold>Folder path:</Text>
      </Box>

      <Box>
        <TextInput
          isDisabled={focusedField !== "path"}
          placeholder="Enter folder path..."
          onChange={handlePathChange}
          defaultValue={config.path}
        />
      </Box>

      <Box marginTop={2}>
        <Text bold>Description (optional):</Text>
      </Box>

      <Box>
        <TextInput
          isDisabled={focusedField !== "description"}
          placeholder="AI-powered workspace for..."
          onChange={handleDescriptionChange}
          defaultValue={config.description}
        />
      </Box>

      <Box marginTop={2}>
        <Text bold>Select agents:</Text>
      </Box>

      <Box>
        <MultiSelect
          isDisabled={focusedField !== "agents"}
          options={[
            { label: "LLM Agent (For AI-powered tasks with Anthropic Claude)", value: "llm" },
            { label: "Tempest Agent (Built-in agent for system operations)", value: "tempest" },
            { label: "Remote Agent (Connect to external HTTP agents)", value: "remote" },
          ]}
          onChange={handleAgentsChange}
          defaultValue={config.agents}
        />
      </Box>

      <Box marginTop={2}>
        <Text bold>Configure signal triggers:</Text>
      </Box>

      <Box>
        <MultiSelect
          isDisabled={focusedField !== "signals"}
          options={[
            { label: "CLI Trigger (Manual triggering from command line)", value: "cli" },
            { label: "HTTP Webhook (Trigger via HTTP POST requests)", value: "http" },
            { label: "Scheduled (Time-based automatic triggers)", value: "schedule" },
          ]}
          onChange={handleSignalsChange}
          defaultValue={config.signals}
        />
      </Box>

      <Box marginTop={2}>
        <Text
          backgroundColor={focusedField === "submit" ? "yellow" : undefined}
          color={focusedField === "submit" ? "black" : "yellow"}
        >
          Submit {focusedField === "submit" ? "[Enter]" : ""}
        </Text>
      </Box>
    </Box>
  );
};

export const InitView = ({ onExit }: InitViewProps) => {
  return (
    <ThemeProvider theme={customTheme}>
      <InitViewContent onExit={onExit} />
    </ThemeProvider>
  );
};
