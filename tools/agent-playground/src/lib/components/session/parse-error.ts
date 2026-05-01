export type ParsedError = { prefix: string; reason: string } | { raw: string };

function cleanEscapes(str: string): string {
  return str.replace(/\\"/g, '"').replace(/\\n/g, "\n");
}

/**
 * Parse error strings like `LLM step failed: {"reason":"..."}`.
 * Returns { prefix, reason } when the pattern matches, otherwise { raw }.
 */
export function parseError(err: string): ParsedError {
  const match = err.match(/^(.+?):\s*(\{.+\})\s*$/s);
  if (match && match[1] && match[2]) {
    try {
      const parsed: unknown = JSON.parse(match[2]);
      if (parsed && typeof parsed === "object" && "reason" in parsed) {
        const reason = (parsed as { reason: string }).reason;
        return { prefix: match[1], reason };
      }
    } catch {
      // not valid JSON, fall through
    }
  }

  return { raw: cleanEscapes(err) };
}
