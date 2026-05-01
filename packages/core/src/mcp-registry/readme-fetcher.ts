/**
 * Fetches README markdown from a public GitHub repository.
 *
 * Parses the repository URL from upstream registry data, constructs the
 * raw.githubusercontent.com URL, and tries `main` then `master` as the
 * default branch. Handles subfolder paths when the server lives in a
 * subdirectory of a monorepo.
 *
 * @module
 */

import { createLogger } from "@atlas/logger";

const logger = createLogger({ name: "mcp-readme-fetcher" });

/**
 * Parse a GitHub repository URL into owner/repo parts.
 *
 * Supports:
 * - `https://github.com/owner/repo`
 * - `https://github.com/owner/repo.git`
 * - `github.com/owner/repo`
 *
 * Returns null for non-GHub URLs.
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim().replace(/\.git$/i, "");
  const match = trimmed.match(/^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/\s]+)/i);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Build the raw.githubusercontent.com URL for a README.
 */
function buildReadmeUrl(owner: string, repo: string, branch: string, subfolder?: string): string {
  const path = subfolder ? `${subfolder}/README.md` : "README.md";
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

/**
 * Fetch README markdown from a repository URL.
 *
 * Tries the `main` branch first, then falls back to `master`.
 * Returns the markdown content as a string, or null if not found
 * or the URL is not a GitHub repository.
 *
 * @param repoUrl - Repository URL (e.g. `https://github.com/owner/repo`)
 * @param subfolder - Optional subdirectory path within the repo
 * @param fetchFn - Fetch implementation (defaults to global fetch)
 */
export async function fetchReadme(
  repoUrl: string,
  subfolder?: string,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string | null> {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    logger.debug("not a github url, skipping readme fetch", { repoUrl });
    return null;
  }

  const { owner, repo } = parsed;

  for (const branch of ["main", "master"]) {
    const url = buildReadmeUrl(owner, repo, branch, subfolder);
    try {
      const response = await fetchFn(url, { method: "GET" });
      if (response.status === 200) {
        const text = await response.text();
        logger.debug("readme fetched", { owner, repo, branch, length: text.length });
        return text;
      }
      if (response.status === 404) {
        logger.debug("readme not found on branch", { owner, repo, branch });
        continue;
      }
      logger.warn("unexpected status fetching readme", {
        owner,
        repo,
        branch,
        status: response.status,
      });
    } catch (error) {
      logger.warn("failed to fetch readme", {
        owner,
        repo,
        branch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}
