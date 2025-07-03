import { Box, Text, useInput } from "ink";
import { defaultTheme, extendTheme, TextInput, ThemeProvider } from "@inkjs/ui";
import { useCallback, useState } from "react";
import { useAppContext } from "../contexts/app-context.tsx";

// Custom theme with yellow highlights for TextInput components
const customTheme = extendTheme(defaultTheme, {
  components: {
    TextInput: {
      styles: {
        frame: () => ({
          color: "yellow",
        }),
      },
    },
  },
});

interface ConfigViewProps {
  onExit: () => void;
}

const ConfigViewContent = ({ onExit }: ConfigViewProps) => {
  const { config, updateConfig } = useAppContext();
  const [localConfig, setLocalConfig] = useState(config);

  const [focusedField, setFocusedField] = useState<
    | "apiKey"
    | "daemonPort"
    | "streamMessages"
    | "submit"
    | "yes"
    | "no"
  >("apiKey");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  useInput((input, key) => {
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
          confirmSave();
        } else {
          setShowConfirmation(false);
          setFocusedField("apiKey");
        }
        return;
      }
    } else {
      if (key.tab) {
        setFocusedField((prev) => {
          if (prev === "apiKey") return "daemonPort";
          if (prev === "daemonPort") return "streamMessages";
          if (prev === "streamMessages") return "submit";
          return "apiKey";
        });
        return;
      }

      if (focusedField === "streamMessages" && input === " ") {
        setLocalConfig((prev) => ({ ...prev, streamMessages: !prev.streamMessages }));
        return;
      }

      if (key.return && focusedField === "submit") {
        setShowConfirmation(true);
        setFocusedField("yes");
        return;
      }
    }
  });

  const confirmSave = () => {
    // Update the app context with the new config
    updateConfig(localConfig);
    setShowSuccess(true);
  };

  const handleApiKeyChange = useCallback((value: string) => {
    setLocalConfig((prev) => ({ ...prev, apiKey: value }));
  }, []);

  const handleDaemonPortChange = useCallback((value: string) => {
    setLocalConfig((prev) => ({ ...prev, daemonPort: value }));
  }, []);

  if (showSuccess) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="green">
          Configuration saved successfully!
        </Text>
        <Box marginTop={1}>
          <Text>API Key: {localConfig.apiKey ? "••••••••" : "(not set)"}</Text>
        </Box>
        <Box>
          <Text>Daemon Port: {localConfig.daemonPort}</Text>
        </Box>
        <Box>
          <Text>Stream Messages: {localConfig.streamMessages ? "Enabled" : "Disabled"}</Text>
        </Box>
        <Box marginTop={2}>
          <Text dimColor>Press Enter to continue...</Text>
        </Box>
      </Box>
    );
  }

  if (showConfirmation) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text bold>Review Configuration</Text>
        <Box marginTop={1}>
          <Text>API Key: {localConfig.apiKey ? "••••••••" : "(not set)"}</Text>
        </Box>
        <Box>
          <Text>Daemon Port: {localConfig.daemonPort}</Text>
        </Box>
        <Box>
          <Text>Stream Messages: {localConfig.streamMessages ? "Enabled" : "Disabled"}</Text>
        </Box>

        <Box marginTop={2} flexDirection="row" gap={4}>
          <Text
            backgroundColor={focusedField === "yes" ? "yellow" : undefined}
            color={focusedField === "yes" ? "black" : "yellow"}
          >
            Save
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
        <Text bold>Atlas Configuration</Text>
      </Box>

      <Box marginTop={2}>
        <Text bold>API Key:</Text>
      </Box>

      <Box>
        <TextInput
          isDisabled={focusedField !== "apiKey"}
          placeholder="Enter your Anthropic API key..."
          onChange={handleApiKeyChange}
          defaultValue={localConfig.apiKey}
        />
      </Box>

      <Box marginTop={2}>
        <Text bold>Daemon Port:</Text>
      </Box>

      <Box>
        <TextInput
          isDisabled={focusedField !== "daemonPort"}
          placeholder="8080"
          onChange={handleDaemonPortChange}
          defaultValue={localConfig.daemonPort}
        />
      </Box>

      <Box marginTop={2}>
        <Text bold>Stream Messages:</Text>
      </Box>

      <Box>
        <Text
          backgroundColor={focusedField === "streamMessages" ? "yellow" : undefined}
          color={focusedField === "streamMessages" ? "black" : undefined}
        >
          {localConfig.streamMessages ? "✓ Enabled" : "✗ Disabled"}
        </Text>
      </Box>

      <Box marginTop={2}>
        <Text
          backgroundColor={focusedField === "submit" ? "yellow" : undefined}
          color={focusedField === "submit" ? "black" : "yellow"}
        >
          Save Configuration {focusedField === "submit" ? "[Enter]" : ""}
        </Text>
      </Box>
    </Box>
  );
};

export const ConfigView = ({ onExit }: ConfigViewProps) => {
  return (
    <ThemeProvider theme={customTheme}>
      <ConfigViewContent onExit={onExit} />
    </ThemeProvider>
  );
};
