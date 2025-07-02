import { Box, Text } from "ink";
import { useTextInputState } from "./use-text-input-state.ts";
import { useTextInput } from "./use-text-input.ts";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";

export type TextInputProps = {
  /** When disabled, user input is ignored. @default false */
  readonly isDisabled?: boolean;

  /** Text to display when input is empty. */
  readonly placeholder?: string;

  /** Default input value. */
  readonly defaultValue?: string;

  /** Suggestions to autocomplete the input value. */
  readonly suggestions?: string[];

  /** Callback when input value changes. */
  readonly onChange?: (value: string) => void;

  /** Callback when enter is pressed. First argument is input value. */
  readonly onSubmit?: (value: string) => void;

  /** Callback when tab is pressed and should change focus instead of accepting suggestion. */
  readonly onTabFocus?: () => void;
};

export function TextInput({
  isDisabled = false,
  defaultValue,
  placeholder = "",
  suggestions,
  onChange,
  onSubmit,
  onTabFocus,
}: TextInputProps) {
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  const state = useTextInputState({
    defaultValue,
    suggestions,
    onChange,
    onSubmit,
  });

  const { inputValue } = useTextInput({
    isDisabled,
    placeholder,
    state,
    onTabFocus,
  });

  // Split the input value by both \n and \r and render each line separately
  const lines = inputValue.split(/[\n\r]/);

  return (
    <Box
      flexDirection="column"
      width={dimensions.paddedWidth - 6}
      flexWrap="wrap"
    >
      {lines.map((line, index) => (
        <Box key={index} overflow="hidden" width="100%">
          <Text wrap="wrap">{line}&nbsp;</Text>
        </Box>
      ))}
    </Box>
  );
}
