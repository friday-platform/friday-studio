/**
 * Pure policy for whether the dedicated liveness listener should bind.
 *
 * Lives in its own file so it can be unit-tested without dragging in
 * `atlas-daemon.ts`'s transitive Deno-runtime imports (the daemon's
 * full vitest harness is broken; this helper sidesteps that).
 *
 * The 65500 cap on FRIDAY_PORT_FRIDAY (in tools/friday-launcher/
 * project.go) guarantees `<port>+1` stays in the bindable range, so
 * the only case the equal-port guard exists for is deliberate disable
 * (an explicit `--health-port == --port`, e.g. from tests or
 * single-listener deployments).
 */
export function shouldBindHealthListener(
  port: number | undefined,
  healthPort: number | undefined,
): boolean {
  if (!healthPort || healthPort <= 0) return false;
  if (healthPort === port) return false;
  return true;
}
