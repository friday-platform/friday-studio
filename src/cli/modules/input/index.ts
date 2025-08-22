export { TextInput, type TextInputProps } from "./text-input.tsx";
export { useTextInput, type UseTextInputProps, type UseTextInputResult } from "./use-text-input.ts";
export {
  type TextInputState,
  useTextInputState,
  type UseTextInputStateProps,
} from "./use-text-input-state.ts";
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
