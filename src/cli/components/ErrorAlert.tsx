import React from "react";
import { Box, Text } from "ink";

interface ErrorAlertProps {
  message: string;
  visible: boolean;
}

export const ErrorAlert = ({ message, visible }: ErrorAlertProps) => {
  if (!visible) return null;

  const space = " ".repeat(message.length);

  return (
    <Box position="absolute" top={0} left={0} right={0} bottom={0}>
      <Box flexDirection="column" height="100%">
        <Box flexDirection="column" borderStyle="single" borderColor="red">
          <Text wrap="wrap" backgroundColor="black" color="black">
            &nbsp;&nbsp;{space}&nbsp;&nbsp;
          </Text>
          <Text wrap="wrap" backgroundColor="black">
            &nbsp;&nbsp;{message}&nbsp;&nbsp;
          </Text>

          <Text wrap="wrap" dimColor backgroundColor="black">
            &nbsp;&nbsp;Press any key to dismiss&nbsp;&nbsp;
          </Text>

          <Text wrap="wrap" backgroundColor="black" color="black">
            &nbsp;&nbsp;{space}&nbsp;&nbsp;
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
