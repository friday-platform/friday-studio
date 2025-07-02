import { useMemo } from "react";
import { useInput } from "ink";
import chalk from "chalk";
import { type TextInputState } from "./use-text-input-state.ts";

export type UseTextInputProps = {
  /** When disabled, user input is ignored. */
  isDisabled?: boolean;

  /** Text input state. */
  state: TextInputState;

  /** Text to display when input is empty. */
  placeholder?: string;

  /** Callback when tab is pressed and should change focus instead of accepting suggestion. */
  onTabFocus?: () => void;
};

export type UseTextInputResult = {
  /** Input value. */
  inputValue: string;
};

const cursor = chalk.inverse(" ");

export const useTextInput = ({
  isDisabled = false,
  state,
  placeholder = "",
  onTabFocus,
}: UseTextInputProps): UseTextInputResult => {
  const renderedPlaceholder = useMemo(() => {
    if (isDisabled) {
      return placeholder ? chalk.dim(placeholder) : "";
    }

    return placeholder && placeholder.length > 0
      ? chalk.inverse(placeholder[0]) + chalk.dim(placeholder.slice(1))
      : cursor;
  }, [isDisabled, placeholder]);

  const renderedValue = useMemo(() => {
    if (isDisabled) {
      return state.value;
    }

    // Handle empty input
    if (state.value.length === 0) {
      return cursor;
    }

    let index = 0;
    let result = "";
    let cursorInserted = false;

    for (const char of state.value) {
      if (index === state.cursorOffset) {
        if (char === "\n" || char === "\r") {
          // If cursor is at a newline, insert cursor before the newline
          result += cursor + char;
        } else {
          result += chalk.inverse(char);
        }
        cursorInserted = true;
      } else {
        result += char;
      }
      index++;
    }

    if (state.suggestion) {
      if (state.cursorOffset === state.value.length) {
        result += chalk.inverse(state.suggestion[0]) +
          chalk.dim(state.suggestion.slice(1));
      } else {
        result += chalk.dim(state.suggestion);
      }

      return result;
    }

    // Show cursor at the end if we're at the end of the text and haven't inserted cursor yet
    if (state.cursorOffset === state.value.length && !cursorInserted) {
      result += cursor;
    }

    return result;
  }, [isDisabled, state.value, state.cursorOffset, state.suggestion]);

  const inputValue = useMemo(() => {
    if (state.value.length > 0) {
      return renderedValue;
    }

    return renderedPlaceholder;
  }, [state.value.length, renderedValue, renderedPlaceholder]);

  useInput((input, key) => {
    // Handle Meta+b (backward word) and Meta+f (forward word)
    if (key.meta && input) {
      if (input === "b") {
        // Meta+b: move to previous word
        state.moveCursorWordLeft();
        return;
      }
      if (input === "f") {
        // Meta+f: move to next word
        state.moveCursorWordRight();
        return;
      }
    }

    // Handle Ctrl+a (beginning of line) and Ctrl+e (end of line)
    if (key.ctrl && input) {
      if (input === "a") {
        // Ctrl+a: move to beginning of line
        state.moveCursorLineStart();
        return;
      }
      if (input === "e") {
        // Ctrl+e: move to end of line
        state.moveCursorLineEnd();
        return;
      }
      if (input === "u") {
        // Ctrl+u: delete from cursor to beginning of line
        state.deleteToLineStart();
        return;
      }
    }

    if (key.leftArrow) {
      // Normal left arrow
      state.moveCursorLeft();
      return;
    }

    if (key.rightArrow) {
      // Normal right arrow
      state.moveCursorRight();
      return;
    }

    if (key.upArrow) {
      state.moveCursorUp();
      return;
    }

    if (key.downArrow) {
      state.moveCursorDown();
      return;
    }

    if (key.return) {
      // Check for multi-line key combinations
      if (key.shift) {
        // Shift+Enter: Insert \n
        state.insert("\n");
      } else if (key.meta) {
        // Option+Enter: Insert \r
        state.insert("\r");
      } else {
        // Normal enter submits
        state.submit();
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (key.meta) {
        // Meta+delete: delete word
        state.deleteWord();
      } else {
        // Normal delete
        state.delete();
      }
      return;
    }

    if (key.tab) {
      if (state.suggestion && !state.justAcceptedSuggestion) {
        // Accept the suggestion
        state.acceptSuggestion();
      } else {
        // Either no suggestion or just accepted one, pass tab through for focus handling
        state.clearSuggestionFlag();
        onTabFocus?.();
      }
      return;
    }

    if (input) {
      // Don't insert characters when modifier keys (except shift) are pressed
      const hasModifierKeys = key.ctrl || key.meta;

      if (!hasModifierKeys) {
        state.insert(input);
      }
    }
  });

  return {
    inputValue,
  };
};
