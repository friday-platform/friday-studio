import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { TextInput } from "../modules/input/text-input.tsx";
import { COMMAND_DEFINITIONS } from "../utils/command-definitions.ts";
import type { AttachmentData } from "../modules/input/use-text-input-state.ts";
import { useAppContext } from "../contexts/app-context.tsx";

export interface CommandInputProps {
  onSubmit: (command: string) => void;
  isDisabled?: boolean;
}

export const CommandInput = ({
  onSubmit,
  isDisabled = false,
}: CommandInputProps) => {
  const { exitApp, diagnosticsStatus, daemonStatus, multilineSetupStatus, multilineTerminalType } =
    useAppContext();

  const [currentInput, setCurrentInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [inputKey, setInputKey] = useState(0);
  const [attachments, setAttachments] = useState<Map<number, AttachmentData>>(
    new Map(),
  );
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Get all available suggestions with descriptions
  const getAllSuggestionsWithDescriptions = () => COMMAND_DEFINITIONS;

  // Get all available suggestions (commands only)
  const getAllSuggestions = () => getAllSuggestionsWithDescriptions().map((item) => item.command);

  // Get filtered suggestions based on current input
  const getFilteredSuggestions = () => {
    if (!currentInput.startsWith("/")) return [];

    // Remove the leading "/" for searching within command names
    const searchTerm = currentInput.slice(1).toLowerCase();

    return getAllSuggestionsWithDescriptions().filter((item) =>
      // Search within the command name (without the leading "/")
      item.command.slice(1).toLowerCase().includes(searchTerm)
    );
  };

  // Handle keyboard navigation like SplashScreen
  useInput((input, key) => {
    // When we're in suggestion navigation mode
    if (showSuggestions) {
      if (key.upArrow) {
        const filteredSuggestions = getFilteredSuggestions();
        setSelectedSuggestionIndex((prev) => prev <= 0 ? filteredSuggestions.length - 1 : prev - 1);
        return;
      }
      if (key.downArrow) {
        const filteredSuggestions = getFilteredSuggestions();
        setSelectedSuggestionIndex((prev) => prev >= filteredSuggestions.length - 1 ? 0 : prev + 1);
        return;
      }

      if (key.escape || key.tab) {
        // Go back to input mode
        setSelectedSuggestionIndex(-1);
        return;
      }

      // Any character input goes back to input mode
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        // Reset selection to let TextInput handle the input
        setSelectedSuggestionIndex(-1);
        // Let the input be handled by TextInput
        return;
      }
    }
  });

  // Handle input changes from TextInput
  const handleInputChange = (
    value: string,
    textInputAttachments?: Map<number, AttachmentData>,
  ) => {
    // If attachments are provided from TextInput, use them
    if (textInputAttachments) {
      setAttachments(textInputAttachments);
    }

    // Normal input handling
    const isSlashCommand = value.startsWith("/");

    if (isSlashCommand) {
      // Calculate filtered suggestions based on the new value
      // Remove the leading "/" for searching within command names
      const searchTerm = value.slice(1).toLowerCase();
      const filteredSuggestions = getAllSuggestionsWithDescriptions().filter(
        (item) => item.command.slice(1).toLowerCase().includes(searchTerm),
      );

      // If there's only one item and we're already at index 0, only update input but skip other state changes
      if (filteredSuggestions.length === 1 && selectedSuggestionIndex === 0) {
        setCurrentInput(value);
        return;
      }

      // Update all state normally
      setCurrentInput(value);
      setShowSuggestions(true);

      // Only set index to 0 if we're not in suggestion mode and there are suggestions
      if (selectedSuggestionIndex === -1 && filteredSuggestions.length > 0) {
        setSelectedSuggestionIndex(0);
      }
    } else {
      // Normal update
      setCurrentInput(value);
      setShowSuggestions(false);
    }
  };

  // Enhanced submission handler
  const handleSubmit = (
    command: string,
    submittedAttachments?: Map<number, AttachmentData>,
  ) => {
    let commandToSubmit = command.trim();

    // If we have a selected suggestion, use that instead
    if (selectedSuggestionIndex >= 0) {
      const filteredSuggestions = getFilteredSuggestions();
      const selectedSuggestion = filteredSuggestions[selectedSuggestionIndex];
      if (selectedSuggestion) {
        commandToSubmit = selectedSuggestion.command;
      }
    }

    // Expand attachments in the command
    const finalAttachments = submittedAttachments || attachments;

    // Find all placeholders and their corresponding attachments
    let expandedCommand = commandToSubmit;
    finalAttachments.forEach((attachmentData, id) => {
      const placeholder = `[#${id} ${attachmentData.lineCount} lines of text]`;
      if (expandedCommand.includes(placeholder)) {
        expandedCommand = expandedCommand.replace(
          placeholder,
          attachmentData.content,
        );
      }
    });
    commandToSubmit = expandedCommand;

    // Always reset input state
    setCurrentInput("");
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    setInputKey((prev) => prev + 1);

    // Clear attachments after submission
    setAttachments(new Map());

    // Submit the command
    onSubmit(commandToSubmit);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box
        borderStyle="round"
        borderColor={isDisabled ? "gray" : "gray"}
        paddingX={1}
      >
        <Text dimColor>→&nbsp;</Text>
        <TextInput
          key={inputKey}
          suggestions={getAllSuggestions()}
          placeholder=" Enter a message or type / for commands..."
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          isDisabled={isDisabled}
          defaultValue={currentInput}
          enableAttachments
          exitApp={exitApp}
        />
      </Box>

      {/* Always show row with conditional contents */}
      <Box flexDirection="row" justifyContent="space-between">
        {/* Left side: suggestions (always present box) */}
        <Box flexDirection="row" paddingX={2}>
          {showSuggestions && (
            <>
              <Box flexDirection="column" marginRight={1}>
                {getFilteredSuggestions().map((suggestion, index) => (
                  <Text
                    key={suggestion.command}
                    color={index === selectedSuggestionIndex ? "yellow" : ""}
                  >
                    {suggestion.command}
                  </Text>
                ))}
              </Box>
              <Box flexDirection="column" paddingLeft={1}>
                {getFilteredSuggestions().map((suggestion, index) => (
                  <Text
                    key={`${suggestion.command}-desc`}
                    color={index === selectedSuggestionIndex ? "yellow" : ""}
                    dimColor={index !== selectedSuggestionIndex}
                  >
                    {suggestion.description}
                  </Text>
                ))}
              </Box>
            </>
          )}
        </Box>

        {diagnosticsStatus !== "idle" && (
          <Box flexDirection="row" paddingX={2}>
            {diagnosticsStatus === "collecting" && <Text dimColor>Collecting...</Text>}

            {diagnosticsStatus === "uploading" && <Text dimColor>Sending...</Text>}

            {diagnosticsStatus === "done" && <Text color="green">Diagnostics sent</Text>}

            {diagnosticsStatus === "error" && <Text color="red">Error: {diagnosticsStatus}</Text>}
          </Box>
        )}

        {daemonStatus !== "idle" && (
          <Box flexDirection="row" paddingX={2}>
            {daemonStatus === "healthy" && <Text color="green">✓ Atlas daemon is running</Text>}
            {daemonStatus === "unhealthy" && (
              <Text color="yellow">◆ Atlas daemon is not running</Text>
            )}
            {daemonStatus === "error" && <Text color="red">Error: {daemonStatus}</Text>}
          </Box>
        )}

        {multilineSetupStatus !== "idle" && (
          <Box flexDirection="row" paddingX={2}>
            {multilineSetupStatus === "running" && <Text dimColor>Configuring terminal...</Text>}

            {multilineSetupStatus === "done" && (
              <Text color="green">
                Multiline input enabled
                {multilineTerminalType === "Apple_Terminal" &&
                  ". Please restart Terminal.app to apply changes"}
              </Text>
            )}

            {multilineSetupStatus !== "running" && multilineSetupStatus !== "done" && (
              <Text color="red">Error: {multilineSetupStatus}</Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
};
