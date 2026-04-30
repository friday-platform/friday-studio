import type { ToolCallDisplay } from "./types.ts";

export function isInProgress(state: ToolCallDisplay["state"]): boolean {
  return state === "input-streaming" || state === "input-available";
}

/**
 * Calls that must render outside the collapsible group.
 *
 * `display_artifact` is state-independent so the call doesn't migrate between
 * `regularCalls` (inside the burst) and `actionCalls` (outside) as state
 * transitions — that migration was the source of a visible flash where the
 * burst bar briefly showed "1 tool call · display_artifact" before the
 * artifact card appeared underneath. The artifact card itself handles the
 * pre-input state by rendering its loading skeleton until `artifactId` lands.
 *
 * `connect_service` / `connect_communicator` stay state-conditional: their
 * interactive card is only meaningful once the tool is awaiting user input,
 * and surfacing it earlier would render with no provider/kind to show.
 */
export function needsUserAction(call: ToolCallDisplay): boolean {
  if (call.toolName === "display_artifact") return true;
  if (call.toolName === "connect_service" && call.state === "output-available") return true;
  return false;
}

export function isError(state: ToolCallDisplay["state"]): boolean {
  return state === "output-error" || state === "output-denied";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function argPreview(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const obj = input as Record<string, unknown>;
  if (toolName === "web_fetch" && typeof obj.url === "string") {
    try {
      return new URL(obj.url).hostname;
    } catch {
      return obj.url.slice(0, 40);
    }
  }
  if (toolName === "web_search" && typeof obj.query === "string") {
    return obj.query.slice(0, 60);
  }
  if (toolName === "run_code" && typeof obj.language === "string") {
    return String(obj.language);
  }
  if (
    (toolName === "read_file" || toolName === "write_file" || toolName === "list_files") &&
    typeof obj.path === "string"
  ) {
    return obj.path;
  }
  if (toolName === "delegate" && typeof obj.goal === "string") {
    return obj.goal.length > 60 ? `${obj.goal.slice(0, 60)}…` : obj.goal;
  }
  if (toolName === "load_skill" && typeof obj.name === "string") {
    return obj.name;
  }
  if (toolName === "memory_save" && typeof obj.text === "string") {
    return obj.text.length > 60 ? `${obj.text.slice(0, 60)}…` : obj.text;
  }
  if (toolName === "display_artifact") {
    return "";
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 60 ? `${v.slice(0, 60)}…` : v;
    }
  }
  return "";
}

export function outputSummary(toolName: string, output: unknown): string {
  if (typeof output !== "object" || output === null) return "";
  const obj = output as Record<string, unknown>;
  if (typeof obj.error === "string") return obj.error;
  if (toolName === "web_fetch") {
    const url = typeof obj.sourceUrl === "string" ? obj.sourceUrl : "";
    const fromCache = obj.fromCache === true ? " (cached)" : "";
    if (url) {
      try {
        return `${new URL(url).hostname}${fromCache}`;
      } catch {
        return `${url.slice(0, 40)}${fromCache}`;
      }
    }
  }
  if (toolName === "web_search" && Array.isArray(obj.results)) {
    return `${obj.results.length} result${obj.results.length === 1 ? "" : "s"}`;
  }
  if (toolName === "run_code" && typeof obj.duration_ms === "number") {
    const exitCode = typeof obj.exit_code === "number" ? obj.exit_code : 0;
    return exitCode === 0
      ? `exit 0 · ${obj.duration_ms} ms`
      : `exit ${exitCode} · ${obj.duration_ms} ms`;
  }
  if (toolName === "read_file" && typeof obj.size_bytes === "number") {
    return `${obj.size_bytes} bytes`;
  }
  if (toolName === "write_file" && typeof obj.bytes_written === "number") {
    return `${obj.bytes_written} bytes written`;
  }
  if (toolName === "list_files" && Array.isArray(obj.entries)) {
    return `${obj.entries.length} entr${obj.entries.length === 1 ? "y" : "ies"}`;
  }
  if (toolName === "display_artifact") {
    const disp = obj.displayed as Record<string, unknown> | undefined;
    if (typeof disp?.title === "string" && disp.title) return disp.title;
    return "";
  }
  return "";
}

export function childrenAnyRunning(children: ToolCallDisplay[]): boolean {
  return children.some(
    (c) => isInProgress(c.state) || (c.children ? childrenAnyRunning(c.children) : false),
  );
}
