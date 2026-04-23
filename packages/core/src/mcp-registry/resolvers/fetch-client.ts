/**
 * Thin wrapper over globalThis.fetch. Exists as a module export so tests
 * can replace `defaultFetchClient` with a stub — avoids monkey-patching
 * `globalThis.fetch` in test suites.
 *
 * Production callers pass the default client; test callers pass a mock.
 * The validator itself has no knowledge of fetch — it only knows the
 * `PackageResolver` interface.
 */

export interface FetchClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export const defaultFetchClient: FetchClient = {
  fetch: (url, init) => globalThis.fetch(url, init),
};
