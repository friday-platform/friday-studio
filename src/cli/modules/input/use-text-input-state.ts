import { type Reducer, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { detectFilePaths, hasFileExtension } from "./file-path-detector.ts";

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
    cursorColumn: lines.length > 0 ? (lines[lines.length - 1]?.length ?? 0) : 0,
  };
};

const getOffsetFromPosition = (text: string, cursorLine: number, cursorColumn: number): number => {
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
  while (i < chars.length && chars[i] && /\w/.test(chars[i])) {
    i++;
  }

  // Skip all non-word characters (whitespace, punctuation, symbols)
  while (i < chars.length && chars[i] && !/\w/.test(chars[i])) {
    i++;
  }

  return Math.min(i, chars.length);
};

const findPrevWordBoundary = (text: string, offset: number): number => {
  const chars = Array.from(text);
  let i = Math.max(0, offset - 1);

  // Skip all non-word characters (whitespace, punctuation, symbols)
  while (i >= 0 && chars[i] && !/\w/.test(chars[i])) {
    i--;
  }

  // Skip current word characters
  while (i >= 0 && chars[i] && /\w/.test(chars[i])) {
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
  attachments: Map<number, AttachmentData>;
  attachmentCounter: number;
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
  | InsertAttachmentAction
  | SetAttachmentsAction
  | DeleteAction
  | DeleteWordAction
  | DeleteToLineStartAction
  | ClearAction;

type MoveCursorLeftAction = { type: "move-cursor-left" };

type MoveCursorRightAction = { type: "move-cursor-right" };

type InsertAction = { type: "insert"; text: string };

type InsertAttachmentAction = {
  type: "insert-attachment";
  text: string;
  lineCount?: number;
  attachmentType: "text" | "file";
  fileName?: string;
};

type SetAttachmentsAction = { type: "set-attachments"; attachments: Map<number, AttachmentData> };

type MoveCursorUpAction = { type: "move-cursor-up" };

type MoveCursorDownAction = { type: "move-cursor-down" };

type MoveCursorWordLeftAction = { type: "move-cursor-word-left" };

type MoveCursorWordRightAction = { type: "move-cursor-word-right" };

type MoveCursorLineStartAction = { type: "move-cursor-line-start" };

type MoveCursorLineEndAction = { type: "move-cursor-line-end" };

type DeleteAction = { type: "delete" };

type DeleteWordAction = { type: "delete-word" };

type DeleteToLineStartAction = { type: "delete-to-line-start" };

type ClearAction = { type: "clear" };

const reducer: Reducer<State, Action> = (state, action) => {
  const updateCursorPosition = (newValue: string, newOffset: number) => {
    const { cursorLine, cursorColumn } = getCursorPosition(newValue, newOffset);
    return { cursorLine, cursorColumn };
  };

  switch (action.type) {
    case "move-cursor-left": {
      const newOffset = Math.max(0, state.cursorOffset - 1);
      return { ...state, cursorOffset: newOffset, ...updateCursorPosition(state.value, newOffset) };
    }

    case "move-cursor-right": {
      const newOffset = Math.min(state.value.length, state.cursorOffset + 1);
      return { ...state, cursorOffset: newOffset, ...updateCursorPosition(state.value, newOffset) };
    }

    case "move-cursor-up": {
      const lines = getLines(state.value);
      if (state.cursorLine > 0) {
        const targetLine = state.cursorLine - 1;
        const targetColumn = Math.min(state.cursorColumn, lines[targetLine]?.length || 0);
        const newOffset = getOffsetFromPosition(state.value, targetLine, targetColumn);
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
        const targetColumn = Math.min(state.cursorColumn, lines[targetLine]?.length || 0);
        const newOffset = getOffsetFromPosition(state.value, targetLine, targetColumn);
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
      return { ...state, cursorOffset: newOffset, ...updateCursorPosition(state.value, newOffset) };
    }

    case "move-cursor-word-right": {
      const newOffset = findNextWordBoundary(state.value, state.cursorOffset);
      return { ...state, cursorOffset: newOffset, ...updateCursorPosition(state.value, newOffset) };
    }

    case "move-cursor-line-start": {
      const newOffset = findLineStart(state.value, state.cursorOffset);
      return { ...state, cursorOffset: newOffset, ...updateCursorPosition(state.value, newOffset) };
    }

    case "move-cursor-line-end": {
      const newOffset = findLineEnd(state.value, state.cursorOffset);
      return { ...state, cursorOffset: newOffset, ...updateCursorPosition(state.value, newOffset) };
    }

    case "insert": {
      const newValue =
        state.value.slice(0, state.cursorOffset) +
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

    case "insert-attachment": {
      return {
        ...state,
        attachments: new Map(state.attachments).set(state.attachmentCounter, {
          content: action.text,
          lineCount: action.lineCount,
          type: action.attachmentType,
          fileName: action.fileName,
        }),
        attachmentCounter: state.attachmentCounter + 1,
      };
    }

    case "set-attachments": {
      return { ...state, attachments: action.attachments };
    }

    case "delete": {
      const newCursorOffset = Math.max(0, state.cursorOffset - 1);
      const newValue =
        state.value.slice(0, newCursorOffset) + state.value.slice(newCursorOffset + 1);

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

    case "clear": {
      return {
        attachments: new Map<number, AttachmentData>(),
        attachmentCounter: 1,
        previousValue: state.value,
        value: "",
        cursorOffset: 0,
        cursorLine: 0,
        cursorColumn: 0,
      };
    }
  }
};

export type AttachmentData = {
  content: string; // For text: the actual text content. For files: the full file path
  lineCount?: number; // Only for text attachments
  type: "text" | "file";
  fileName?: string; // Only for file attachments - the extracted file/folder name
};

type UseTextInputStateProps = {
  defaultValue?: string;
  suggestions?: string[];
  enableAttachments?: boolean;
  onChange?: (value: string, attachments?: Map<number, AttachmentData>) => void;
  onSubmit?: (value: string, attachments?: Map<number, AttachmentData>) => void;
  exitApp?: () => Promise<void>;
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
  insertAttachment: (text: string) => void;
  delete: () => void;
  deleteWord: () => void;
  deleteToLineStart: () => void;
  submit: () => void;
  acceptSuggestion: () => void;
  clearSuggestionFlag: () => void;
  clear: () => void;
  exit: () => void;
};

export const useTextInputState = ({
  defaultValue = "",
  suggestions,
  enableAttachments = false,
  onChange,
  onSubmit,
  exitApp,
}: UseTextInputStateProps): TextInputState => {
  const [state, dispatch] = useReducer(reducer, {
    attachments: new Map<number, AttachmentData>(),
    attachmentCounter: 1,
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
    dispatch({ type: "move-cursor-left" });
  }, []);

  const moveCursorRight = useCallback(() => {
    dispatch({ type: "move-cursor-right" });
  }, []);

  const moveCursorUp = useCallback(() => {
    dispatch({ type: "move-cursor-up" });
  }, []);

  const moveCursorDown = useCallback(() => {
    dispatch({ type: "move-cursor-down" });
  }, []);

  const moveCursorWordLeft = useCallback(() => {
    dispatch({ type: "move-cursor-word-left" });
  }, []);

  const moveCursorWordRight = useCallback(() => {
    dispatch({ type: "move-cursor-word-right" });
  }, []);

  const moveCursorLineStart = useCallback(() => {
    dispatch({ type: "move-cursor-line-start" });
  }, []);

  const moveCursorLineEnd = useCallback(() => {
    dispatch({ type: "move-cursor-line-end" });
  }, []);

  const clear = useCallback(() => {
    dispatch({ type: "clear" });
  }, []);

  const exit = useCallback(() => {
    if (exitApp) {
      state.attachments.clear();
      exitApp();
    }
  }, [exitApp]);

  const insertAttachment = useCallback(
    (text: string) => {
      // Count lines to determine if this should be a text attachment
      const newlineCount = (text.match(/[\n\r]/g) || []).length;
      const shouldBeTextAttachment = enableAttachments && newlineCount >= 10;

      // Check if the pasted content contains file paths
      const detectedPaths = detectFilePaths(text);

      // Special case: If the ENTIRE paste is just file paths (one per line),
      // treat them as file attachments. Otherwise, if it's large text with
      // some file paths mixed in, treat the whole thing as a text attachment
      const lines = text.trim().split(/[\n\r]+/);
      const isOnlyFilePaths =
        lines.length > 0 &&
        lines.length === detectedPaths.length &&
        detectedPaths.every((path) => lines.includes(path.originalText.trim()));

      // If it's purely file paths, handle as file attachments
      if (enableAttachments && detectedPaths.length > 0 && isOnlyFilePaths) {
        let processedText = text;
        const attachmentIds: number[] = [];

        // Process each detected file path
        detectedPaths.forEach((pathInfo) => {
          const attachmentId = state.attachmentCounter + attachmentIds.length;
          const isDirectory = !hasFileExtension(pathInfo.originalText);
          const separator = Deno.build.os === "windows" ? "\\" : "/";
          const placeholder = isDirectory
            ? `[#${attachmentId} ${pathInfo.fileName}${separator}]`
            : `[#${attachmentId} ${pathInfo.fileName}]`;

          // Store the attachment
          dispatch({
            type: "insert-attachment",
            text: pathInfo.originalText,
            attachmentType: "file",
            fileName: pathInfo.fileName,
          });

          attachmentIds.push(attachmentId);

          // Replace the original path with the placeholder
          processedText = processedText.replace(pathInfo.originalText, placeholder);
        });

        // Insert the processed text with placeholders
        dispatch({ type: "insert", text: processedText });

        return;
      }

      // Original text attachment logic - for large text blocks
      if (shouldBeTextAttachment) {
        // Always create a new attachment for each paste
        const attachmentId = state.attachmentCounter;
        const placeholder = `[#${attachmentId} ${newlineCount} lines of text]`;

        dispatch({
          type: "insert-attachment",
          text,
          lineCount: newlineCount,
          attachmentType: "text",
        });

        // Insert placeholder with ID and line count
        dispatch({ type: "insert", text: placeholder });

        return;
      }

      // For small pastes or when attachments are disabled, just insert as-is
      dispatch({ type: "insert", text });
    },
    [enableAttachments, state.attachmentCounter],
  );

  const insert = useCallback((text: string) => {
    dispatch({ type: "insert", text });

    // Clear the suggestion flag when new text is inserted
    setJustAcceptedSuggestion(false);
  }, []);

  const deleteCharacter = useCallback(() => {
    const newCursorOffset = Math.max(0, state.cursorOffset - 1);
    const newValue = state.value.slice(0, newCursorOffset) + state.value.slice(state.cursorOffset);

    // Check if any attachments were deleted
    if (enableAttachments && state.attachments.size > 0) {
      // Create a map to track which attachment IDs are still present
      const remainingAttachmentIds = new Set<number>();

      // Check each attachment to see if its placeholder still exists
      state.attachments.forEach((attachmentData, id) => {
        let placeholder: string;
        if (attachmentData.type === "file") {
          const isDirectory = attachmentData.fileName && !hasFileExtension(attachmentData.content);
          const separator = Deno.build.os === "windows" ? "\\" : "/";
          placeholder = isDirectory
            ? `[#${id} ${attachmentData.fileName}${separator}]`
            : `[#${id} ${attachmentData.fileName}]`;
        } else {
          placeholder = `[#${id} ${attachmentData.lineCount} lines of text]`;
        }

        if (newValue.includes(placeholder)) {
          remainingAttachmentIds.add(id);
        }
      });

      // Remove attachments that are no longer in the text
      if (remainingAttachmentIds.size < state.attachments.size) {
        const updatedAttachments = new Map<number, AttachmentData>();
        remainingAttachmentIds.forEach((id) => {
          const attachmentData = state.attachments.get(id);
          if (attachmentData) {
            updatedAttachments.set(id, attachmentData);
          }
        });

        dispatch({ type: "set-attachments", attachments: updatedAttachments });
      }
    }

    dispatch({ type: "delete" });
    // Clear the suggestion flag when text is deleted
    setJustAcceptedSuggestion(false);
  }, [state.value, state.cursorOffset, enableAttachments, state.attachments]);

  const deleteWord = useCallback(() => {
    dispatch({ type: "delete-word" });
    // Clear the suggestion flag when text is deleted
    setJustAcceptedSuggestion(false);
  }, []);

  const deleteToLineStart = useCallback(() => {
    dispatch({ type: "delete-to-line-start" });
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
      onSubmit?.(state.value + suggestion, state.attachments);
      return;
    }

    onSubmit?.(state.value, state.attachments);
  }, [state.value, suggestion, insert, onSubmit, state.attachments]);

  useEffect(() => {
    // Call onChange when internal state changes
    if (state.value !== state.previousValue) {
      onChange?.(state.value, state.attachments);
    }
  }, [state.previousValue, state.value, onChange, state.attachments]);

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
    insertAttachment,
    delete: deleteCharacter,
    deleteWord,
    deleteToLineStart,
    submit,
    acceptSuggestion,
    clearSuggestionFlag,
    clear,
    exit,
  };
};
