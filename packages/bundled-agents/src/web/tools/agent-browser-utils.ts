/**
 * Parse a command string into an array of arguments.
 * Handles both single-quoted and double-quoted strings as single arguments,
 * stripping the quotes. Single quotes are important for eval commands where
 * the JS expression may contain double quotes internally.
 *
 * @example
 * parseCommandArgs('fill @e5 "hello world"')                    // ["fill", "@e5", "hello world"]
 * parseCommandArgs("snapshot -i")                               // ["snapshot", "-i"]
 * parseCommandArgs(`eval 'document.querySelector("btn")'`)      // ["eval", 'document.querySelector("btn")']
 */
export function parseCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoteChar: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quoteChar !== null) {
      // Inside quotes — only the matching quote char closes
      if (char === quoteChar) {
        args.push(current);
        current = "";
        quoteChar = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      // Opening quote — push accumulated text first
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      quoteChar = char;
    } else if (char === " ") {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * Extracts a useful error message from a failed execFile call.
 * Node's child_process always sets `stderr` as a string (even empty),
 * so we check for non-empty stderr first, then fall back to signal/timeout
 * info and finally error.message.
 */
export function formatExecError(error: unknown): string {
  if (error == null || typeof error !== "object") {
    return String(error);
  }

  const parts: string[] = [];

  if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
    parts.push(error.stderr.trim());
  }

  if ("killed" in error && error.killed) {
    parts.push("command timed out");
  } else if ("signal" in error && error.signal) {
    parts.push(`killed by ${String(error.signal)}`);
  }

  if ("code" in error && error.code != null && typeof error.code === "number") {
    parts.push(`exit code ${String(error.code)}`);
  }

  if (parts.length > 0) {
    return parts.join(" — ");
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
