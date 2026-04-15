/**
 * Abstraction over platform configuration sources (filesystem, embedded,
 * KV-backed, etc.). Implementations return a fully Zod-validated `AtlasConfig`
 * or `null` when no config is available.
 */

import type { AtlasConfig } from "./workspace.ts";

/**
 * Source of platform (friday.yml) configuration. The platform does not
 * structurally depend on the filesystem being the source of truth —
 * alternate implementations (embedded, KV-backed, API-backed) can plug in.
 */
export interface AtlasConfigSource {
  /**
   * Return the parsed platform configuration, or `null` if no config is
   * available. Implementations must validate through Zod before returning.
   */
  load(): Promise<AtlasConfig | null>;
}
