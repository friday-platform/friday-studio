import process from "node:process";
import { ConfirmInput, Spinner, StatusMessage, TextInput } from "@inkjs/ui";
import { Box, render, Text, useApp, useInput } from "ink";

// Types for our prompt utilities
interface PromptOptions {
  message: string;
  placeholder?: string;
  defaultValue?: string | boolean;
  validate?: (value: string) => string | undefined;
}

interface SelectOption {
  label: string;
  value: string;
  hint?: string;
}

// Spinner utility that matches @clack/prompts API
export const spinner = () => {
  let stopFn: (() => void) | null = null;

  return {
    start: (label: string) => {
      const { unmount } = render(<Spinner label={label} />);
      stopFn = unmount;
    },
    stop: (message?: string) => {
      if (stopFn) {
        stopFn();
        stopFn = null;
      }
      if (message) {
        console.log(message);
      }
    },
  };
};

// Text input prompt
export const text = async (options: PromptOptions): Promise<string | symbol> => {
  return new Promise((resolve) => {
    const TextPrompt = () => {
      const { exit } = useApp();

      useInput((input, key) => {
        if (key.escape || (key.ctrl && input === "c")) {
          resolve(Symbol("cancel"));
          exit();
        }
      });

      return (
        <Box flexDirection="column" gap={1}>
          <Text>{options.message}</Text>
          <TextInput
            placeholder={options.placeholder}
            defaultValue={options.defaultValue}
            onSubmit={(value) => {
              if (options.validate) {
                const error = options.validate(value);
                if (error) {
                  // For now, just log the error and continue
                  console.error(error);
                  return;
                }
              }
              resolve(value);
              exit();
            }}
          />
        </Box>
      );
    };

    render(<TextPrompt />);
  });
};

// Confirm prompt
export const confirm = async (options: PromptOptions): Promise<boolean | symbol> => {
  return new Promise((resolve) => {
    const ConfirmPrompt = () => {
      const { exit } = useApp();

      useInput((input, key) => {
        if (key.escape || (key.ctrl && input === "c")) {
          resolve(Symbol("cancel"));
          exit();
        }
      });

      return (
        <Box flexDirection="column" gap={1}>
          <Text>{options.message}</Text>
          <ConfirmInput
            defaultChoice={options.defaultValue ? "confirm" : "cancel"}
            onConfirm={() => {
              resolve(true);
              exit();
            }}
            onCancel={() => {
              resolve(false);
              exit();
            }}
          />
        </Box>
      );
    };

    render(<ConfirmPrompt />);
  });
};

// Cancel helper
export const cancel = (message: string) => {
  render(
    <Box paddingY={1}>
      <StatusMessage variant="error">{message}</StatusMessage>
    </Box>,
  );
  process.exit(1);
};

// Check if value is cancelled
export const isCancel = (value: any): value is symbol => {
  return typeof value === "symbol" && value.description === "cancel";
};
