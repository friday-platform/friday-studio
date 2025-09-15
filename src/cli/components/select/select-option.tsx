import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { theme } from "./theme.ts";

interface SelectOptionProps {
  /** Determines if option is focused. */
  readonly isFocused: boolean;

  /** Determines if option is selected. */
  readonly isSelected: boolean;

  /** Option label. */
  readonly children: ReactNode;
}

export function SelectOption({ isFocused, isSelected, children }: SelectOptionProps) {
  const { styles } = theme;

  return (
    <Box {...styles.option({ isFocused })}>
      {isFocused && <Text {...styles.focusIndicator()}>❯</Text>}

      <Text {...styles.label({ isFocused, isSelected })}>{children}</Text>

      {isSelected && <Text {...styles.selectedIndicator()}>✓</Text>}
    </Box>
  );
}
