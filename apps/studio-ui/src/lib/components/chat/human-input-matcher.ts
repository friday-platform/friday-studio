import type { Elicitation } from "@atlas/core/elicitations/model";
import type { ToolCallDisplay } from "./types.ts";

export type HumanInputOption = { label: string; value: string };

export type HumanInputRequest = {
  question: string;
  options?: HumanInputOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptions(value: unknown): HumanInputOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: HumanInputOption[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const { label, value: optionValue } = item;
    if (typeof label !== "string" || typeof optionValue !== "string") {
      return undefined;
    }
    options.push({ label, value: optionValue });
  }
  return options.length > 0 ? options : undefined;
}

export function readHumanInputRequest(
  call: ToolCallDisplay,
): HumanInputRequest | null {
  if (call.toolName !== "request_human_input") return null;
  if (!isRecord(call.input)) return null;
  const { question } = call.input;
  if (typeof question !== "string" || question.trim().length === 0) return null;
  const options = readOptions(call.input.options);
  return { question, ...(options ? { options } : {}) };
}

export function readElicitationIdFromToolOutput(
  call: ToolCallDisplay,
): string | null {
  const output = call.output;
  if (isRecord(output) && typeof output.elicitationId === "string") {
    return output.elicitationId;
  }
  if (isRecord(output) && Array.isArray(output.content)) {
    for (const part of output.content) {
      if (!isRecord(part) || typeof part.text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(part.text);
        if (isRecord(parsed) && typeof parsed.elicitationId === "string") {
          return parsed.elicitationId;
        }
      } catch {
        // Not JSON — ignore.
      }
    }
  }
  return null;
}

function optionValues(
  options: readonly HumanInputOption[] | undefined,
): string[] {
  return (options ?? []).map((o) => o.value).sort();
}

function optionsMatch(
  request: HumanInputRequest,
  elicitation: Elicitation,
): boolean {
  const requestValues = optionValues(request.options);
  const elicitationValues = optionValues(elicitation.options);
  if (requestValues.length === 0 && elicitationValues.length === 0) return true;
  if (requestValues.length !== elicitationValues.length) return false;
  return requestValues.every((value, idx) => value === elicitationValues[idx]);
}

export function findMatchingHumanInputElicitation(
  call: ToolCallDisplay,
  elicitations: readonly Elicitation[],
  workspaceId?: string,
): Elicitation | null {
  const byOutputId = readElicitationIdFromToolOutput(call);
  if (byOutputId) {
    const direct = elicitations.find((e) => e.id === byOutputId);
    if (direct) return direct;
  }

  const request = readHumanInputRequest(call);
  if (!request) return null;

  const candidates = elicitations
    .filter((e) => e.kind === "open-question")
    .filter((e) => (workspaceId ? e.workspaceId === workspaceId : true))
    .filter((
      e,
    ) => (call.workspaceId ? e.workspaceId === call.workspaceId : true))
    .filter((e) => (call.sessionId ? e.sessionId === call.sessionId : true))
    .filter((e) => (call.actionId ? e.actionId === call.actionId : true))
    .filter((e) => e.question === request.question)
    .filter((e) => optionsMatch(request, e));

  if (candidates.length === 0) return null;

  // Prefer the newest matching request. Re-running the same workflow can
  // leave older pending/expired prompts with identical question text; after
  // the current one is answered, we must not jump backward to an older
  // pending prompt just because it is still terminally unresolved.
  return candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
    null;
}
