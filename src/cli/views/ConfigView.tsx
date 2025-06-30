import { Box, Text, useInput } from "ink";
import { defaultTheme, extendTheme, TextInput, ThemeProvider } from "@inkjs/ui";
import { useCallback, useState } from "react";

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

interface AtlasConfig {
  apiKey: string;
  daemonPort: string;
}

interface ConfigViewProps {
  onExit: () => void;
}

const ConfigViewContent = ({ onExit }: ConfigViewProps) => {
  const [config, setConfig] = useState<AtlasConfig>({
    apiKey: "",
    daemonPort: "8080",
  });

  const [focusedField, setFocusedField] = useState<
    | "apiKey"
    | "daemonPort"
    | "submit"
    | "yes"
    | "no"
  >("apiKey");
  const [showConfirmation, setShowConfirmation] = useState(false);
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
          if (prev === "daemonPort") return "submit";
          return "apiKey";
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

  const confirmSave = () => {
    // For now, we just show success without actually storing
    setShowSuccess(true);
  };

  const handleApiKeyChange = useCallback((value: string) => {
    setConfig((prev) => ({ ...prev, apiKey: value }));
  }, []);

  const handleDaemonPortChange = useCallback((value: string) => {
    setConfig((prev) => ({ ...prev, daemonPort: value }));
  }, []);

  if (showSuccess) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="green">
          Configuration saved successfully!
        </Text>
        <Box marginTop={1}>
          <Text>API Key: {config.apiKey ? "••••••••" : "(not set)"}</Text>
        </Box>
        <Box>
          <Text>Daemon Port: {config.daemonPort}</Text>
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
          <Text>API Key: {config.apiKey ? "••••••••" : "(not set)"}</Text>
        </Box>
        <Box>
          <Text>Daemon Port: {config.daemonPort}</Text>
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
          defaultValue={config.apiKey}
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
          defaultValue={config.daemonPort}
        />
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
