/**
 * Stub for @db/sqlite — the real module uses Deno FFI which is unavailable
 * in Vite's Node-based SSR. The playground never calls Database methods at
 * SSR time, so an empty export is sufficient.
 */
export class Database {
  constructor() {
    throw new Error("@db/sqlite stub: not available in Vite SSR");
  }
}
