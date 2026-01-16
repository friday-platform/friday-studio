export interface OutputEntry {
  id: string;
  type:
    | "text" // response
    | "reasoning"
    | "request"
    | "finish"
    | "tool_call"
    | "tool_result"
    | "error"
    | "header"
    | "typing"
    | "credential_linked"
    | "intent";
  author?: string;
  timestamp?: string;
  content?: string;
  currentlyStreaming?: boolean;
  metadata?: Record<string, unknown>;
}
