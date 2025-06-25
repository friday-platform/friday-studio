import React, { useEffect, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { Alert, ConfirmInput, MultiSelect, Spinner, StatusMessage, TextInput } from "@inkjs/ui";

// Types for our prompt utilities
export interface PromptOptions {
  message: string;
  placeholder?: string;
  defaultValue?: string | boolean;
  validate?: (value: string) => string | undefined;
}

export interface SelectOption {
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
      const [value, setValue] = useState("");
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
            defaultValue={options.defaultValue as string}
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

// Multi-select prompt
export const multiselect = async (options: {
  message: string;
  options: SelectOption[];
  required?: boolean;
}): Promise<string[] | symbol> => {
  return new Promise((resolve) => {
    const MultiSelectPrompt = () => {
      const [selected, setSelected] = useState<string[]>([]);
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
          <MultiSelect
            options={options.options.map((opt) => ({
              label: opt.hint ? `${opt.label} (${opt.hint})` : opt.label,
              value: opt.value,
            }))}
            onChange={setSelected}
            onSubmit={(values) => {
              resolve(values);
              exit();
            }}
          />
        </Box>
      );
    };

    render(<MultiSelectPrompt />);
  });
};

// Group prompt - manages multiple prompts in sequence
export const group = async <T extends Record<string, any>>(
  prompts: Record<string, (results: Partial<T>) => Promise<any>>,
): Promise<T | symbol> => {
  const results: Partial<T> = {};

  for (const [key, promptFn] of Object.entries(prompts)) {
    const result = await promptFn(results);
    if (isCancel(result)) {
      return Symbol("cancel");
    }
    results[key as keyof T] = result;
  }

  return results as T;
};

// Intro message
export const intro = (message: string) => {
  render(
    <Box paddingY={1}>
      <Text bold color="cyan">┌ {message}</Text>
    </Box>,
  );
};

// Outro message
export const outro = (message: string) => {
  render(
    <Box paddingY={1}>
      <Text color="green">└ {message}</Text>
    </Box>,
  );
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

// Note component for additional info
export const note = (message: string, title?: string) => {
  render(
    <Box paddingY={1}>
      <Alert variant="info" title={title}>
        {message}
      </Alert>
    </Box>,
  );
};
