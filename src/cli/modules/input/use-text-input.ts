import chalk from "chalk";
import { useStdin } from "ink";
import { useEffect, useMemo } from "react";
import { useKeypress } from "./key-press.ts";
import type { TextInputState } from "./use-text-input-state.ts";

type UseTextInputProps = {
  /** When disabled, user input is ignored. */
  isDisabled?: boolean;

  /** Text input state. */
  state: TextInputState;

  /** Text to display when input is empty. */
  placeholder?: string;

  /** Callback when tab is pressed and should change focus instead of accepting suggestion. */
  onTabFocus?: () => void;

  /** Callback when escape is pressed, typically to cancel current operation. */
  onCancel?: () => void;
};

type UseTextInputResult = {
  /** Input value. */
  inputValue: string;
};

const cursor = chalk.inverse(" ");

export const useTextInput = ({
  isDisabled = false,
  state,
  placeholder = "",
  onTabFocus,
  onCancel,
}: UseTextInputProps): UseTextInputResult => {
  const renderedPlaceholder = useMemo(() => {
    if (isDisabled) {
      return placeholder ? chalk.dim(placeholder) : "";
    }

    return placeholder && placeholder.length > 0
      ? chalk.inverse(placeholder[0]) + chalk.dim(placeholder.slice(1))
      : cursor;
  }, [isDisabled, placeholder]);

  const { setRawMode, stdin } = useStdin();

  useKeypress(
    ({ ctrl, meta, paste, sequence, name }) => {
      if (meta && sequence) {
        if (name === "b") {
          // Meta+b: move to previous word
          state.moveCursorWordLeft();
        }
        if (name === "f") {
          // Meta+f: move to next word
          state.moveCursorWordRight();
        }

        if (name === "backspace") {
          state.deleteWord();
        }

        if (name === "return") {
          state.insert("\n");
        }

        return;
      }

      // Handle Ctrl+a (beginning of line) and Ctrl+e (end of line)
      if (ctrl && sequence) {
        if (name === "a") {
          // Ctrl+a: move to beginning of line
          state.moveCursorLineStart();
        }
        if (name === "e") {
          // Ctrl+e: move to end of line
          state.moveCursorLineEnd();
        }
        if (name === "u") {
          // Ctrl+u: delete from cursor to beginning of line
          state.deleteToLineStart();
        }

        if (name === "c") {
          if (state.value.length > 0) {
            state.clear();
          } else {
            state.exit();
          }
        }

        return;
      }

      if (name === "left") {
        // Normal left arrow
        state.moveCursorLeft();

        return;
      }

      if (name === "right") {
        // Normal right arrow
        state.moveCursorRight();

        return;
      }

      if (name === "up") {
        state.moveCursorUp();

        return;
      }

      if (name === "down") {
        state.moveCursorDown();

        return;
      }

      if (name === "backspace" && !meta) {
        // Normal delete
        state.delete();

        return;
      }

      if (name === "tab") {
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

      if (name === "enter") {
        state.insert("\r");

        return;
      }

      if (name === "return") {
        state.submit();

        return;
      }

      if (name === "escape") {
        // Call the cancel callback if provided
        onCancel?.();

        return;
      }

      if (paste) {
        state.insertAttachment(sequence);
      } else {
        // Don't insert characters when modifier keys (except shift) are pressed
        const hasModifierKeys = ctrl || meta;

        if (!hasModifierKeys) {
          state.insert(sequence);
        }
      }
    },
    { isActive: !isDisabled },
  );

  useEffect(() => {
    if (isDisabled || !stdin.isTTY) {
      return;
    }

    setRawMode(true);

    return () => {
      setRawMode(false);
    };
  }, [stdin, isDisabled, setRawMode]);

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
        result += chalk.inverse(state.suggestion[0]) + chalk.dim(state.suggestion.slice(1));
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

  return { inputValue };
};
