import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

interface Option {
  label: string;
  value: string;
}

interface MultiSelectProps {
  options: Option[];
  defaultValue?: string[];
  onChange?: (values: string[]) => void;
  isDisabled?: boolean;
}

export const MultiSelect = ({
  options,
  defaultValue = [],
  onChange,
  isDisabled = false,
}: MultiSelectProps) => {
  const [selectedValues, setSelectedValues] = useState<string[]>(defaultValue);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [numberInput, setNumberInput] = useState("");

  // Update internal state when defaultValue changes
  useEffect(() => {
    setSelectedValues(defaultValue);
  }, [defaultValue]);

  useInput(
    (input, key) => {
      if (key.upArrow || (key.shift && key.tab)) {
        setFocusedIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1));
      } else if (key.downArrow || key.tab) {
        setFocusedIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0));
      } else if (input === " ") {
        const option = options[focusedIndex];
        const newSelectedValues = selectedValues.includes(option?.value || "")
          ? selectedValues.filter((v) => v !== option?.value)
          : [...selectedValues, option?.value || ""];

        setSelectedValues(newSelectedValues);
        onChange?.(newSelectedValues);
      } else if (/[0-9]/.test(input)) {
        // only less than 9 options support number selection
        if (options.length > 9) return;

        const newNumberInput = numberInput + input;
        setNumberInput(newNumberInput);

        const targetIndex = parseInt(newNumberInput, 10) - 1;

        if (targetIndex >= 0 && targetIndex < options.length) {
          const option = options[targetIndex];
          const newSelectedValues = selectedValues.includes(option?.value || "")
            ? selectedValues.filter((v) => v !== option?.value)
            : [...selectedValues, option?.value || ""];

          setSelectedValues(newSelectedValues);
          onChange?.(newSelectedValues);
          setFocusedIndex(targetIndex);
        }
        // Clear after processing
        setNumberInput("");
      }
    },
    { isActive: !isDisabled },
  );

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {options.map((option, index) => {
        const isSelected = selectedValues.includes(option.value);
        const isFocused = index === focusedIndex && !isDisabled;

        return (
          <Box key={option.value}>
            <Text color={isFocused ? "yellow" : undefined} dimColor={isDisabled || !isSelected}>
              {options.length < 10 ? `${index + 1}. ` : ""}
              {isSelected ? "●" : "○"}
              &nbsp;{option.label}
            </Text>

            {isFocused && <Text dimColor>⇠</Text>}
          </Box>
        );
      })}
    </Box>
  );
};
