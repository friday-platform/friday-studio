/** Converts unknown error shapes to a readable string. Handles Error instances, plain objects, and primitives. */
export function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  // AI SDK errors are often plain objects with a message property, not Error instances
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}
