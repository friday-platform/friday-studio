import { Box, Text } from "ink";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";
import { useTextInput } from "./use-text-input.ts";
import type { AttachmentData } from "./use-text-input-state.ts";
import { useTextInputState } from "./use-text-input-state.ts";

export type TextInputProps = {
  /** When disabled, user input is ignored. @default false */
  readonly isDisabled?: boolean;

  /** Text to display when input is empty. */
  readonly placeholder?: string;

  /** Default input value. */
  readonly defaultValue?: string;

  /** Suggestions to autocomplete the input value. */
  readonly suggestions?: string[];

  /** Enable attachment support for pasted content. @default false */
  readonly enableAttachments?: boolean;

  /** Callback when input value changes. */
  readonly onChange?: (value: string, attachments?: Map<number, AttachmentData>) => void;

  /** Callback when enter is pressed. First argument is input value. */
  readonly onSubmit?: (value: string, attachments?: Map<number, AttachmentData>) => void;

  /** Callback when tab is pressed and should change focus instead of accepting suggestion. */
  readonly onTabFocus?: () => void;

  /** Callback when Ctrl+c is pressed. */
  readonly exitApp?: () => Promise<void>;
};

export function TextInput({
  isDisabled = false,
  defaultValue,
  placeholder = "",
  suggestions,
  enableAttachments = false,
  onChange,
  onSubmit,
  onTabFocus,
  exitApp,
}: TextInputProps) {
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  const state = useTextInputState({
    defaultValue,
    suggestions,
    enableAttachments,
    onChange,
    onSubmit,
    exitApp,
  });

  const { inputValue } = useTextInput({ isDisabled, placeholder, state, onTabFocus });

  // Split the input value by both \n and \r and render each line separately
  const lines = inputValue.split(/[\n\r]/);

  return (
    <Box flexDirection="column" width={dimensions.paddedWidth - 6} flexWrap="wrap">
      {lines.map((line, index) => (
        <Box key={index} overflow="hidden" width="100%">
          <Text wrap="wrap">{line}&nbsp;</Text>
        </Box>
      ))}
    </Box>
  );
}
