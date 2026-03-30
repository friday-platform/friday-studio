/**
 * OTEL bootstrap — must be loaded BEFORE the main CLI entry point.
 *
 * Deno's built-in OTEL (when OTEL_DENO=true) populates the JS-level global
 * Symbol.for("opentelemetry.js.api.1") with its TracerProvider, ContextManager,
 * etc. at process startup, before any JS runs.
 *
 * However, @sentry/deno calls trace.disable() during init, which deletes the
 * trace field from the global. And the npm @opentelemetry/api package (loaded
 * through node_modules by transitive deps like @opentelemetry/sdk-logs) can
 * also lose Deno's pre-populated fields via registerGlobal() reassignment.
 *
 * Fix: replace the OTEL global object with a Proxy that silently ignores
 * delete operations and property overwrites on Deno's original fields. This
 * lets Sentry and other packages think they succeeded while preserving Deno's
 * TracerProvider for custom span creation.
 *
 * Usage: deno run ... apps/atlas-cli/src/otel-bootstrap.ts <args>
 * The deno task definitions use this as the entry point instead of cli.ts.
 */

const sym = Symbol.for("opentelemetry.js.api.1");
const g = globalThis as Record<symbol, unknown>;
const otel = g[sym] as Record<string, unknown> | undefined;

if (otel?.trace) {
  // Snapshot Deno's original keys — only these are protected
  const preserved = new Set<string | symbol>(
    Object.keys(otel).filter((k) => otel[k] !== undefined),
  );

  const proxy = new Proxy(otel, {
    deleteProperty(_target, prop) {
      if (preserved.has(prop)) {
        // Silently "succeed" without actually deleting — Sentry calls
        // unregisterGlobal("trace") which does `delete api.trace`
        return true;
      }
      return Reflect.deleteProperty(_target, prop);
    },
    set(_target, prop, value) {
      if (preserved.has(prop)) {
        // Silently ignore overwrites of Deno's fields
        return true;
      }
      return Reflect.set(_target, prop, value);
    },
  });

  g[sym] = proxy;
}

await import("./cli.ts");
