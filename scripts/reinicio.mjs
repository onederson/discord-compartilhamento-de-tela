/** Backoff curto, exponencial e limitado para processos locais supervisionados. */
export function atrasoReinicio(tentativa, { base = 2_000, max = 30_000 } = {}) {
  const n = Math.max(0, Number.isFinite(tentativa) ? Math.floor(tentativa) : 0);
  return Math.min(max, base * 2 ** n);
}
