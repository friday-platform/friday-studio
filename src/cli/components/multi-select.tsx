import { Box, Text, useInput } from "ink";
import React, { useState, useEffect } from "react";

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

  // Update internal state when defaultValue changes
  useEffect(() => {
    setSelectedValues(defaultValue);
  }, [defaultValue]);

  useInput(
    (input, key) => {
      if (isDisabled) return;

      if (key.upArrow || (key.shift && key.tab)) {
        setFocusedIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1));
      } else if (key.downArrow || key.tab) {
        setFocusedIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0));
      } else if (key.return || input === " ") {
        const option = options[focusedIndex];
        const newSelectedValues = selectedValues.includes(option.value)
          ? selectedValues.filter((v) => v !== option.value)
          : [...selectedValues, option.value];

        setSelectedValues(newSelectedValues);
        onChange?.(newSelectedValues);
      }
    },
    { isActive: !isDisabled }
  );

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {options.map((option, index) => {
        const isSelected = selectedValues.includes(option.value);
        const isFocused = index === focusedIndex && !isDisabled;

        return (
          <Box key={option.value}>
            <Text
              color={isFocused ? "yellow" : undefined}
              dimColor={isDisabled || !isSelected}
            >
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
