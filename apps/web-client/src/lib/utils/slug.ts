export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/**
 * Generates a URL-safe slug from a filename.
 *
 * Strips extension, lowercases, replaces non-alphanumeric chars with hyphens,
 * collapses consecutive hyphens, and trims leading/trailing hyphens.
 *
 * @example
 * generateSlug("Q4 Report (Final).pdf")   // "q4-report-final"
 * generateSlug("data.csv")                // "data"
 * generateSlug("---weird---name---.txt")  // "weird-name"
 */
export function generateSlug(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  return withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const MAX_SLUG_RETRIES = 10;

/**
 * Error thrown when slug collision retries are exhausted.
 */
export class SlugCollisionError extends Error {
  constructor(slug: string) {
    super(`Slug "${slug}" still conflicts after ${MAX_SLUG_RETRIES} attempts`);
    this.name = "SlugCollisionError";
  }
}

/**
 * Retries an upload with incrementing slug suffixes on 409 conflicts.
 *
 * Given a base slug, calls `attempt` with the slug. On a 409 response,
 * retries with `slug-2`, `slug-3`, etc. up to 10 attempts.
 *
 * @returns The result from the first successful attempt.
 * @throws {SlugCollisionError} After 10 failed attempts.
 *
 * @example
 * const result = await retrySlugCollision("report", async (slug) => {
 *   const res = await fetch(`/api/upload`, { body: JSON.stringify({ slug }) });
 *   if (res.status === 409) return { conflict: true as const };
 *   return { conflict: false as const, data: await res.json() };
 * });
 */
export async function retrySlugCollision<T>(
  baseSlug: string,
  attempt: (slug: string) => Promise<{ conflict: true } | { conflict: false; data: T }>,
): Promise<T> {
  // First attempt uses the base slug
  const first = await attempt(baseSlug);
  if (!first.conflict) return first.data;

  // Retry with -2, -3, ... -10
  for (let i = 2; i <= MAX_SLUG_RETRIES + 1; i++) {
    const result = await attempt(`${baseSlug}-${i}`);
    if (!result.conflict) return result.data;
  }

  throw new SlugCollisionError(baseSlug);
}
