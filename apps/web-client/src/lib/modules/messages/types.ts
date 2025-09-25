export interface OutputEntry {
  id: string;
  type:
    | "text" // response
    | "thinking"
    | "request"
    | "finish"
    | "tool_call"
    | "tool_result"
    | "error"
    | "header"
    | "typing";
  author?: string;
  timestamp?: string;
  content?: string;
  currentlyStreaming?: boolean;
  metadata?: Record<string, unknown>;
}
