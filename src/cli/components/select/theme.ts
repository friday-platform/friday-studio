import type { BoxProps, TextProps } from "ink";

interface Theme {
  styles: {
    container(): BoxProps;
    option(options: { isFocused: boolean }): BoxProps;
    selectedIndicator(): TextProps;
    focusIndicator(): TextProps;
    label(options: { isFocused: boolean; isSelected: boolean }): TextProps;
    highlightedText(): TextProps;
  };
}

export const theme: Theme = {
  styles: {
    container: (): BoxProps => ({ flexDirection: "column" }),
    option: ({ isFocused }): BoxProps => ({ gap: 1, paddingLeft: isFocused ? 0 : 2 }),
    selectedIndicator: (): TextProps => ({ color: "yellow" }),
    focusIndicator: (): TextProps => ({ color: "yellow" }),
    label({ isFocused, isSelected }): TextProps {
      let color: string | undefined;

      if (isSelected) {
        color = "yellow";
      }

      if (isFocused) {
        color = "yellow";
      }

      return { color };
    },
    highlightedText: (): TextProps => ({ bold: true }),
  },
};
