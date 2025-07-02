import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { TextInput } from "./text-input/text-input.tsx";
import { COMMAND_DEFINITIONS } from "../utils/command-definitions.ts";
import { useAppContext } from "../contexts/app-context.tsx";
import { LeaderKeyOverlay } from "./leader-key-overlay.tsx";

export interface CommandInputProps {
  onSubmit: (command: string) => void;
  selectedWorkspace?: string | null;
  isDisabled?: boolean;
}

export const CommandInput = ({
  onSubmit,
  selectedWorkspace,
  isDisabled = false,
}: CommandInputProps) => {
  const [currentInput, setCurrentInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [inputKey, setInputKey] = useState(0);
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });
  const { isLeaderKeyActive } = useAppContext();

  // Get all available suggestions with descriptions
  const getAllSuggestionsWithDescriptions = () => COMMAND_DEFINITIONS;

  // Get all available suggestions (commands only)
  const getAllSuggestions = () => getAllSuggestionsWithDescriptions().map((item) => item.command);

  // Get filtered suggestions based on current input
  const getFilteredSuggestions = () => {
    if (!currentInput.startsWith("/")) return [];

    return getAllSuggestionsWithDescriptions().filter((item) =>
      item.command.toLowerCase().includes(currentInput.toLowerCase())
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
        setSelectedSuggestionIndex(-1);
        // Let the input be handled by TextInput
        return;
      }
    }
  });

  // Handle input changes from TextInput
  const handleInputChange = (value: string) => {
    setCurrentInput(value);
    setShowSuggestions(value.startsWith("/"));

    if (value.startsWith("/") && selectedSuggestionIndex === -1) {
      setSelectedSuggestionIndex(0);
    }
  };

  // Enhanced submission handler
  const handleSubmit = (command: string) => {
    let commandToSubmit = command.trim();

    // If we have a selected suggestion, use that instead
    if (selectedSuggestionIndex >= 0) {
      const filteredSuggestions = getFilteredSuggestions();
      const selectedSuggestion = filteredSuggestions[selectedSuggestionIndex];
      if (selectedSuggestion) {
        commandToSubmit = selectedSuggestion.command;
      }
    }

    // Always reset input state
    setCurrentInput("");
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    setInputKey((prev) => prev + 1);

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
        {isLeaderKeyActive ? <LeaderKeyOverlay /> : (
          <>
            <Text dimColor>→&nbsp;</Text>
            <TextInput
              key={inputKey}
              suggestions={getAllSuggestions()}
              placeholder="Enter a message or type / for commands..."
              onChange={handleInputChange}
              onSubmit={handleSubmit}
              isDisabled={isDisabled}
            />
          </>
        )}
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

        {/* Right side: workspace name (always present box) */}
        <Box>
          {selectedWorkspace && <Text color="yellow">{selectedWorkspace}</Text>}
        </Box>
      </Box>
    </Box>
  );
};
