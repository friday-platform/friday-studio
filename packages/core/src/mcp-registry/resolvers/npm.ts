/**
 * Resolves npm package references from MCP stdio transports.
 *
 * Matches the three common spawn shapes:
 *   npx -y <pkg>[@version] [...more]
 *   npx <pkg>[@version] [...more]
 *   bunx -y <pkg>
 *   bunx <pkg>
 *
 * (pnpm dlx <pkg> also works by the same logic if someone uses it — the
 * matcher accepts `pnpm` as command with `dlx` as first arg.)
 *
 * Strips a trailing `@<version>` when looking up the package, since the
 * registry is keyed on the package name. Does not attempt to validate
 * that the requested version exists — version pinning mistakes are a
 * separate failure mode from package-name hallucination.
 *
 * Uses GET instead of HEAD because the npm registry's 404 response for
 * HEAD is the same as for scoped-package auth failures (both omit the
 * body that would disambiguate). GET returns a small JSON payload we
 * ignore but that lets us reliably distinguish 404 from 401/403.
 */

import type { PackageResolver } from "../config-validator.ts";
import { defaultFetchClient, type FetchClient } from "./fetch-client.ts";

const NPM_REGISTRY = "https://registry.npmjs.org";

export function createNpmResolver(fetchClient: FetchClient = defaultFetchClient): PackageResolver {
  const cache = new Map<string, Awaited<ReturnType<PackageResolver["check"]>>>();

  return {
    matches(command, args) {
      if (command !== "npx" && command !== "bunx" && command !== "pnpm") return null;
      const positional = [...args];
      // Drop leading flags: npx -y, npx --yes, pnpm dlx, etc.
      while (positional.length > 0) {
        const head = positional[0];
        if (!head) break;
        if (head === "-y" || head === "--yes" || head === "-q" || head === "--quiet") {
          positional.shift();
          continue;
        }
        if (command === "pnpm" && head === "dlx") {
          positional.shift();
          continue;
        }
        if (head.startsWith("-")) {
          // Unknown flag — we can't reliably strip without parsing the
          // tool's full arg grammar. Bail out so we don't misidentify the
          // package reference.
          return null;
        }
        break;
      }
      const pkgWithVersion = positional[0];
      if (!pkgWithVersion || typeof pkgWithVersion !== "string") return null;
      const ref = stripVersion(pkgWithVersion);
      if (ref.length === 0) return null;
      return { ref };
    },

    async check(ref) {
      const cached = cache.get(ref);
      if (cached) return cached;

      const result = await doCheck(fetchClient, ref);
      cache.set(ref, result);
      return result;
    },
  };
}

function stripVersion(pkgWithVersion: string): string {
  // `@scope/name@version` — keep through second `@`.
  if (pkgWithVersion.startsWith("@")) {
    const slashIdx = pkgWithVersion.indexOf("/");
    if (slashIdx === -1) return pkgWithVersion;
    const versionIdx = pkgWithVersion.indexOf("@", slashIdx);
    return versionIdx === -1 ? pkgWithVersion : pkgWithVersion.slice(0, versionIdx);
  }
  // `name@version` — keep through first `@`.
  const versionIdx = pkgWithVersion.indexOf("@");
  return versionIdx === -1 ? pkgWithVersion : pkgWithVersion.slice(0, versionIdx);
}

async function doCheck(
  client: FetchClient,
  ref: string,
): Promise<Awaited<ReturnType<PackageResolver["check"]>>> {
  // Scoped packages must be URL-encoded: `@scope/name` → `@scope%2Fname`.
  const urlRef = ref.startsWith("@") ? ref.replace("/", "%2F") : ref;
  const url = `${NPM_REGISTRY}/${urlRef}`;

  let res: Response;
  try {
    res = await client.fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      // Short timeout — config validation should not block on slow
      // registries. An unreachable registry degrades to soft-fail anyway.
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (res.status === 200) return { ok: true };
  if (res.status === 404) return { ok: false, reason: "not_found" };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth_required" };
  return { ok: false, reason: "unreachable" };
}
