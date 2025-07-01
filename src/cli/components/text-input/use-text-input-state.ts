import { type Reducer, useCallback, useEffect, useMemo, useReducer, useState } from "react";

// Helper functions for multi-line text handling
const getLines = (text: string): string[] => text.split(/[\n\r]/);

const getCursorPosition = (
  text: string,
  offset: number,
): { cursorLine: number; cursorColumn: number } => {
  const beforeCursor = text.slice(0, offset);
  const lines = beforeCursor.split(/[\n\r]/);
  return {
    cursorLine: lines.length - 1,
    cursorColumn: lines[lines.length - 1].length,
  };
};

const getOffsetFromPosition = (
  text: string,
  cursorLine: number,
  cursorColumn: number,
): number => {
  let offset = 0;
  let currentLine = 0;

  for (let i = 0; i < text.length; i++) {
    if (currentLine === cursorLine) {
      if (offset - (currentLine > 0 ? 1 : 0) >= cursorColumn) {
        break;
      }
    }

    if (text[i] === "\n" || text[i] === "\r") {
      currentLine++;
      if (currentLine > cursorLine) {
        break;
      }
    }

    offset++;
  }

  // Adjust for the target column within the target line
  if (currentLine === cursorLine) {
    const lineStart = findLineStart(text, offset);
    offset = lineStart + Math.min(cursorColumn, findLineEnd(text, lineStart) - lineStart);
  }

  return offset;
};

// Helper functions for word and line navigation
const findNextWordBoundary = (text: string, offset: number): number => {
  const chars = Array.from(text);
  let i = offset;

  // Skip current word characters
  while (i < chars.length && /\w/.test(chars[i])) {
    i++;
  }

  // Skip whitespace
  while (i < chars.length && /\s/.test(chars[i])) {
    i++;
  }

  return Math.min(i, chars.length);
};

const findPrevWordBoundary = (text: string, offset: number): number => {
  const chars = Array.from(text);
  let i = Math.max(0, offset - 1);

  // Skip whitespace
  while (i >= 0 && /\s/.test(chars[i])) {
    i--;
  }

  // Skip current word characters
  while (i >= 0 && /\w/.test(chars[i])) {
    i--;
  }

  return Math.max(0, i + 1);
};

const findLineStart = (text: string, offset: number): number => {
  const beforeCursor = text.slice(0, offset);
  const lastNewline = Math.max(beforeCursor.lastIndexOf("\n"), beforeCursor.lastIndexOf("\r"));
  return lastNewline === -1 ? 0 : lastNewline + 1;
};

const findLineEnd = (text: string, offset: number): number => {
  const afterCursor = text.slice(offset);
  const nextN = afterCursor.indexOf("\n");
  const nextR = afterCursor.indexOf("\r");
  let nextNewline = -1;

  if (nextN === -1 && nextR === -1) {
    nextNewline = -1;
  } else if (nextN === -1) {
    nextNewline = nextR;
  } else if (nextR === -1) {
    nextNewline = nextN;
  } else {
    nextNewline = Math.min(nextN, nextR);
  }

  return nextNewline === -1 ? text.length : offset + nextNewline;
};

type State = {
  previousValue: string;
  value: string;
  cursorOffset: number;
  cursorLine: number;
  cursorColumn: number;
};

type Action =
  | MoveCursorLeftAction
  | MoveCursorRightAction
  | MoveCursorUpAction
  | MoveCursorDownAction
  | MoveCursorWordLeftAction
  | MoveCursorWordRightAction
  | MoveCursorLineStartAction
  | MoveCursorLineEndAction
  | InsertAction
  | DeleteAction
  | DeleteWordAction
  | DeleteToLineStartAction;

type MoveCursorLeftAction = {
  type: "move-cursor-left";
};

type MoveCursorRightAction = {
  type: "move-cursor-right";
};

type InsertAction = {
  type: "insert";
  text: string;
};

type MoveCursorUpAction = {
  type: "move-cursor-up";
};

type MoveCursorDownAction = {
  type: "move-cursor-down";
};

type MoveCursorWordLeftAction = {
  type: "move-cursor-word-left";
};

type MoveCursorWordRightAction = {
  type: "move-cursor-word-right";
};

type MoveCursorLineStartAction = {
  type: "move-cursor-line-start";
};

type MoveCursorLineEndAction = {
  type: "move-cursor-line-end";
};

type DeleteAction = {
  type: "delete";
};

type DeleteWordAction = {
  type: "delete-word";
};

type DeleteToLineStartAction = {
  type: "delete-to-line-start";
};

const reducer: Reducer<State, Action> = (state, action) => {
  const updateCursorPosition = (newValue: string, newOffset: number) => {
    const { cursorLine, cursorColumn } = getCursorPosition(newValue, newOffset);
    return { cursorLine, cursorColumn };
  };

  switch (action.type) {
    case "move-cursor-left": {
      const newOffset = Math.max(0, state.cursorOffset - 1);
      return {
        ...state,
        cursorOffset: newOffset,
        ...updateCursorPosition(state.value, newOffset),
      };
    }

    case "move-cursor-right": {
      const newOffset = Math.min(state.value.length, state.cursorOffset + 1);
      return {
        ...state,
        cursorOffset: newOffset,
        ...updateCursorPosition(state.value, newOffset),
      };
    }

    case "move-cursor-up": {
      const lines = getLines(state.value);
      if (state.cursorLine > 0) {
        const targetLine = state.cursorLine - 1;
        const targetColumn = Math.min(
          state.cursorColumn,
          lines[targetLine].length,
        );
        const newOffset = getOffsetFromPosition(
          state.value,
          targetLine,
          targetColumn,
        );
        return {
          ...state,
          cursorOffset: newOffset,
          cursorLine: targetLine,
          cursorColumn: targetColumn,
        };
      }
      return state;
    }

    case "move-cursor-down": {
      const lines = getLines(state.value);
      if (state.cursorLine < lines.length - 1) {
        const targetLine = state.cursorLine + 1;
        const targetColumn = Math.min(
          state.cursorColumn,
          lines[targetLine].length,
        );
        const newOffset = getOffsetFromPosition(
          state.value,
          targetLine,
          targetColumn,
        );
        return {
          ...state,
          cursorOffset: newOffset,
          cursorLine: targetLine,
          cursorColumn: targetColumn,
        };
      }
      return state;
    }

    case "move-cursor-word-left": {
      const newOffset = findPrevWordBoundary(state.value, state.cursorOffset);
      return {
        ...state,
        cursorOffset: newOffset,
        ...updateCursorPosition(state.value, newOffset),
      };
    }

    case "move-cursor-word-right": {
      const newOffset = findNextWordBoundary(state.value, state.cursorOffset);
      return {
        ...state,
        cursorOffset: newOffset,
        ...updateCursorPosition(state.value, newOffset),
      };
    }

    case "move-cursor-line-start": {
      const newOffset = findLineStart(state.value, state.cursorOffset);
      return {
        ...state,
        cursorOffset: newOffset,
        ...updateCursorPosition(state.value, newOffset),
      };
    }

    case "move-cursor-line-end": {
      const newOffset = findLineEnd(state.value, state.cursorOffset);
      return {
        ...state,
        cursorOffset: newOffset,
        ...updateCursorPosition(state.value, newOffset),
      };
    }

    case "insert": {
      const newValue = state.value.slice(0, state.cursorOffset) +
        action.text +
        state.value.slice(state.cursorOffset);
      const newOffset = state.cursorOffset + action.text.length;

      return {
        ...state,
        previousValue: state.value,
        value: newValue,
        cursorOffset: newOffset,
        ...updateCursorPosition(newValue, newOffset),
      };
    }

    case "delete": {
      const newCursorOffset = Math.max(0, state.cursorOffset - 1);
      const newValue = state.value.slice(0, newCursorOffset) +
        state.value.slice(newCursorOffset + 1);

      return {
        ...state,
        previousValue: state.value,
        value: newValue,
        cursorOffset: newCursorOffset,
        ...updateCursorPosition(newValue, newCursorOffset),
      };
    }

    case "delete-word": {
      const wordStart = findPrevWordBoundary(state.value, state.cursorOffset);
      const newValue = state.value.slice(0, wordStart) + state.value.slice(state.cursorOffset);

      return {
        ...state,
        previousValue: state.value,
        value: newValue,
        cursorOffset: wordStart,
        ...updateCursorPosition(newValue, wordStart),
      };
    }

    case "delete-to-line-start": {
      const lineStart = findLineStart(state.value, state.cursorOffset);
      const newValue = state.value.slice(0, lineStart) + state.value.slice(state.cursorOffset);

      return {
        ...state,
        previousValue: state.value,
        value: newValue,
        cursorOffset: lineStart,
        ...updateCursorPosition(newValue, lineStart),
      };
    }
  }
};

export type UseTextInputStateProps = {
  defaultValue?: string;
  suggestions?: string[];
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
};

export type TextInputState = State & {
  suggestion?: string;
  justAcceptedSuggestion: boolean;
  moveCursorLeft: () => void;
  moveCursorRight: () => void;
  moveCursorUp: () => void;
  moveCursorDown: () => void;
  moveCursorWordLeft: () => void;
  moveCursorWordRight: () => void;
  moveCursorLineStart: () => void;
  moveCursorLineEnd: () => void;
  insert: (text: string) => void;
  delete: () => void;
  deleteWord: () => void;
  deleteToLineStart: () => void;
  submit: () => void;
  acceptSuggestion: () => void;
  clearSuggestionFlag: () => void;
};

export const useTextInputState = ({
  defaultValue = "",
  suggestions,
  onChange,
  onSubmit,
}: UseTextInputStateProps): TextInputState => {
  const [state, dispatch] = useReducer(reducer, {
    previousValue: defaultValue,
    value: defaultValue,
    cursorOffset: defaultValue.length,
    ...getCursorPosition(defaultValue, defaultValue.length),
  });

  const [justAcceptedSuggestion, setJustAcceptedSuggestion] = useState(false);

  const suggestion = useMemo(() => {
    if (state.value.length === 0) {
      return;
    }

    return suggestions
      ?.find((suggestion) => suggestion.startsWith(state.value))
      ?.replace(state.value, "");
  }, [state.value, suggestions]);

  const moveCursorLeft = useCallback(() => {
    dispatch({
      type: "move-cursor-left",
    });
  }, []);

  const moveCursorRight = useCallback(() => {
    dispatch({
      type: "move-cursor-right",
    });
  }, []);

  const moveCursorUp = useCallback(() => {
    dispatch({
      type: "move-cursor-up",
    });
  }, []);

  const moveCursorDown = useCallback(() => {
    dispatch({
      type: "move-cursor-down",
    });
  }, []);

  const moveCursorWordLeft = useCallback(() => {
    dispatch({
      type: "move-cursor-word-left",
    });
  }, []);

  const moveCursorWordRight = useCallback(() => {
    dispatch({
      type: "move-cursor-word-right",
    });
  }, []);

  const moveCursorLineStart = useCallback(() => {
    dispatch({
      type: "move-cursor-line-start",
    });
  }, []);

  const moveCursorLineEnd = useCallback(() => {
    dispatch({
      type: "move-cursor-line-end",
    });
  }, []);

  const insert = useCallback((text: string) => {
    dispatch({
      type: "insert",
      text,
    });
    // Clear the suggestion flag when new text is inserted
    setJustAcceptedSuggestion(false);
  }, []);

  const deleteCharacter = useCallback(() => {
    dispatch({
      type: "delete",
    });
    // Clear the suggestion flag when text is deleted
    setJustAcceptedSuggestion(false);
  }, []);

  const deleteWord = useCallback(() => {
    dispatch({
      type: "delete-word",
    });
    // Clear the suggestion flag when text is deleted
    setJustAcceptedSuggestion(false);
  }, []);

  const deleteToLineStart = useCallback(() => {
    dispatch({
      type: "delete-to-line-start",
    });
    // Clear the suggestion flag when text is deleted
    setJustAcceptedSuggestion(false);
  }, []);

  const acceptSuggestion = useCallback(() => {
    if (suggestion) {
      insert(suggestion);
      setJustAcceptedSuggestion(true);
    }
  }, [suggestion, insert]);

  const clearSuggestionFlag = useCallback(() => {
    setJustAcceptedSuggestion(false);
  }, []);

  const submit = useCallback(() => {
    if (suggestion) {
      insert(suggestion);
      onSubmit?.(state.value + suggestion);
      return;
    }

    onSubmit?.(state.value);
  }, [state.value, suggestion, insert, onSubmit]);

  useEffect(() => {
    if (state.value !== state.previousValue) {
      onChange?.(state.value);
    }
  }, [state.previousValue, state.value, onChange]);

  return {
    ...state,
    suggestion,
    justAcceptedSuggestion,
    moveCursorLeft,
    moveCursorRight,
    moveCursorUp,
    moveCursorDown,
    moveCursorWordLeft,
    moveCursorWordRight,
    moveCursorLineStart,
    moveCursorLineEnd,
    insert,
    delete: deleteCharacter,
    deleteWord,
    deleteToLineStart,
    submit,
    acceptSuggestion,
    clearSuggestionFlag,
  };
};
