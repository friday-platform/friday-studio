/**
 * Resolves Python package references from MCP stdio transports.
 *
 * Matches:
 *   uvx <pkg>[==version] [...]
 *   uvx --from <pkg> <entrypoint>  — the package is after --from
 *   pipx run <pkg> [...]
 *   pipx run --spec <pkg> <entrypoint>
 *
 * Strips version pins (`pkg==1.2.3`, `pkg>=1.0`) before registry lookup.
 * `pypi.org/pypi/<pkg>/json` returns 200 with the package metadata, or
 * 404 when the package doesn't exist. Distinguishing 404 from network
 * error matches the npm resolver's contract.
 */

import type { PackageResolver } from "../config-validator.ts";
import { defaultFetchClient, type FetchClient } from "./fetch-client.ts";

const PYPI_REGISTRY = "https://pypi.org/pypi";

export function createPypiResolver(fetchClient: FetchClient = defaultFetchClient): PackageResolver {
  const cache = new Map<string, Awaited<ReturnType<PackageResolver["check"]>>>();

  return {
    matches(command, args) {
      if (command !== "uvx" && command !== "pipx") return null;
      const positional = [...args];

      // `pipx run` — strip the `run` subcommand.
      if (command === "pipx") {
        if (positional[0] !== "run") return null;
        positional.shift();
      }

      // `--from <pkg>` / `--spec <pkg>` override: the package is the flag's value.
      for (let i = 0; i < positional.length; i++) {
        const flag = positional[i];
        if (flag === "--from" || flag === "--spec") {
          const pkg = positional[i + 1];
          if (!pkg || typeof pkg !== "string") return null;
          const ref = stripVersionSpec(pkg);
          return ref.length === 0 ? null : { ref };
        }
      }

      // Otherwise the first non-flag positional is the package.
      while (positional.length > 0) {
        const head = positional[0];
        if (!head) break;
        if (head.startsWith("-")) {
          // Skip simple boolean flags; bail on unknown.
          if (head === "-q" || head === "--quiet" || head === "-v" || head === "--verbose") {
            positional.shift();
            continue;
          }
          return null;
        }
        break;
      }

      const pkg = positional[0];
      if (!pkg || typeof pkg !== "string") return null;
      const ref = stripVersionSpec(pkg);
      return ref.length === 0 ? null : { ref };
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

function stripVersionSpec(pkg: string): string {
  // PEP 508 / PEP 440 specifiers — split on any version-comparator start.
  const match = /^([A-Za-z0-9_.-]+)/.exec(pkg);
  return match?.[1] ?? "";
}

async function doCheck(
  client: FetchClient,
  ref: string,
): Promise<Awaited<ReturnType<PackageResolver["check"]>>> {
  const url = `${PYPI_REGISTRY}/${encodeURIComponent(ref)}/json`;
  let res: Response;
  try {
    res = await client.fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
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
