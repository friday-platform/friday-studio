/**
 * Default resolver registry for workspace config validation.
 *
 * Order matters: earlier resolvers match first. We keep the ecosystem
 * resolvers (npm, pypi) ahead of local-path because a path like
 * `/usr/local/bin/npx` would otherwise match `npx`. The local-path
 * resolver is reached only when none of the ecosystem matchers apply.
 */

import type { PackageResolver } from "../config-validator.ts";
import { defaultFetchClient, type FetchClient } from "./fetch-client.ts";
import { createLocalPathResolver } from "./local-path.ts";
import { createNpmResolver } from "./npm.ts";
import { createPypiResolver } from "./pypi.ts";

export function createDefaultResolvers(
  fetchClient: FetchClient = defaultFetchClient,
): PackageResolver[] {
  return [
    createNpmResolver(fetchClient),
    createPypiResolver(fetchClient),
    createLocalPathResolver(),
  ];
}

export type { FetchClient };
export { createLocalPathResolver, createNpmResolver, createPypiResolver };
