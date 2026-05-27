export function formatSimilarity(sim: number | null | undefined): string {
  if (sim == null || !isFinite(sim) || isNaN(sim)) return '--%';
  return `${Math.round(sim * 100)}%`;
}
