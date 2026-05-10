/**
 * Tiny relative-time formatter for the Activity surface.
 *
 * Returns "in 12s" / "in 4m" / "in 2h" for future timestamps and the
 * symmetric "12s ago" / "4m ago" / "2h ago" for past ones. Sub-second
 * precision is intentionally dropped — the page re-ticks once per
 * second, so anything smaller is jitter the operator can't act on.
 *
 * Lives next to the Activity components rather than `src/lib/utils/`
 * because it's only used by this route subtree.
 */
export function formatRelative(iso: string, nowMs: number): string {
  const target = new Date(iso).getTime();
  const diff = target - nowMs;
  const past = diff < 0;
  const abs = Math.abs(diff);

  if (abs < 1_000) return past ? "just now" : "in <1s";
  if (abs < 60_000) {
    const s = Math.round(abs / 1_000);
    return past ? `${s}s ago` : `in ${s}s`;
  }
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  const d = Math.round(abs / 86_400_000);
  return past ? `${d}d ago` : `in ${d}d`;
}
