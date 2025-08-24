export {
  createFileAttachmentPlaceholder,
  type DetectedPath,
  detectFilePaths,
  extractFileName,
  extractFilePaths,
  hasFileExtension,
  isFilePath,
  matchesAnyPattern,
  UNIX_PATH_PATTERNS,
  WINDOWS_PATH_PATTERNS,
} from "./file-path-detector.ts";
export { TextInput, type TextInputProps } from "./text-input.tsx";
export { type UseTextInputProps, type UseTextInputResult, useTextInput } from "./use-text-input.ts";
export {
  type TextInputState,
  type UseTextInputStateProps,
  useTextInputState,
} from "./use-text-input-state.ts";
