/** Log scale normalized on a percentile, so that a few extreme files do not flatten the rest. */
export function makeScale(values: number[], percentile = 0.95): (v: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return () => 0;
  }
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))];
  const denom = Math.log1p(Math.max(ref, 1));
  return (v) => (v <= 0 ? 0 : Math.min(1, Math.log1p(v) / denom));
}

export const TIERS = 5;

/** 0 = cold (no activity), 1..5 = from warm to burning. */
export function tierOf(heat: number): number {
  if (heat <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(TIERS, Math.ceil(heat * TIERS)));
}
