import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { SelectOption } from "./select-option.tsx";
import { theme } from "./theme.ts";
import type { Option } from "./types.ts";
import { useSelect } from "./use-select.ts";
import { useSelectState } from "./use-select-state.ts";

interface SelectProps {
  /** When disabled, user input is ignored. */
  readonly isDisabled?: boolean;

  /** Number of visible options. */
  readonly visibleOptionCount?: number;

  /** Highlight text in option labels. */
  readonly highlightText?: string;

  /** Options. */
  readonly options: Option[];

  /** Default value. */
  readonly defaultValue?: string;

  /** Callback when selected option changes. */
  readonly onChange?: (value: string) => void;
}

export function Select({
  isDisabled = false,
  visibleOptionCount = 5,
  highlightText,
  options,
  defaultValue,
  onChange,
}: SelectProps) {
  const state = useSelectState({ visibleOptionCount, options, defaultValue, onChange });

  useSelect({ isDisabled, state });

  const { styles } = theme;

  return (
    <Box {...styles.container()}>
      {state.visibleOptions.map((option) => {
        let label: ReactNode = option.label;

        if (highlightText && option.label.includes(highlightText)) {
          const index = option.label.indexOf(highlightText);

          label = (
            <>
              {option.label.slice(0, index)}
              <Text {...styles.highlightedText()}>{highlightText}</Text>
              {option.label.slice(index + highlightText.length)}
            </>
          );
        }

        return (
          <SelectOption
            key={option.value}
            isFocused={!isDisabled && state.focusedValue === option.value}
            isSelected={state.value === option.value}
          >
            {label}
          </SelectOption>
        );
      })}
    </Box>
  );
}
