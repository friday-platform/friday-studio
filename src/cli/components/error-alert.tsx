// No React import needed with react-jsx
import { Box, Text, useInput } from "ink";

interface ErrorAlertProps {
  message: string;
  visible: boolean;
  onDismiss?: () => void;
}

export const ErrorAlert = ({ message, visible, onDismiss }: ErrorAlertProps) => {
  useInput((_inputChar, _key) => {
    if (visible && onDismiss) {
      onDismiss();
    }
  });

  if (!visible) return null;

  const dismissText = "Press any key to dismiss";
  const additionalSpace = " ".repeat((message.length - dismissText.length + 4) / 2);

  return (
    <Box position="absolute">
      <Box flexDirection="column" height="100%">
        <Box flexDirection="column" borderStyle="single" borderColor="red">
          <Text wrap="wrap" backgroundColor="black" color="black">
            {additionalSpace}
            {additionalSpace}
          </Text>
          <Text wrap="wrap" backgroundColor="black">
            &nbsp;&nbsp;{message}&nbsp;&nbsp;
          </Text>

          <Box>
            <Text wrap="wrap" dimColor backgroundColor="black">
              {additionalSpace}Press any key to dismiss{additionalSpace}
            </Text>
          </Box>

          <Text wrap="wrap" backgroundColor="black" color="black">
            {additionalSpace}
            {additionalSpace}
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
