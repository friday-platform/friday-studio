/**
 * Release channel enum for Atlas distributions
 *
 * Available channels:
 * - Stable: Production-ready compiled releases with version tags (e.g., v1.0.0)
 * - Nightly: Automated nightly builds from the main branch for early testing
 * - Edge: Development builds including source runs and pre-release versions
 */
export enum ReleaseChannel {
  Nightly = "nightly",
  Edge = "edge",
}
