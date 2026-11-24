export type PeriodPreset = 'hoje' | '7dias' | '30dias' | 'mes' | 'mesAnterior';

export const PERIOD_LABEL: Record<PeriodPreset, string> = {
  hoje: 'Hoje',
  '7dias': 'Últimos 7 dias',
  '30dias': 'Últimos 30 dias',
  mes: 'Este mês',
  mesAnterior: 'Mês anterior',
};

/** AAAA-MM-DD no calendário local (sem passar por UTC, que erraria o dia à noite). */
export function toYMD(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function presetRange(
  preset: PeriodPreset,
  now: Date = new Date(),
): { from: string; to: string } {
  const day = (offset: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  switch (preset) {
    case 'hoje':
      return { from: toYMD(day(0)), to: toYMD(day(0)) };
    case '7dias':
      return { from: toYMD(day(-6)), to: toYMD(day(0)) };
    case '30dias':
      return { from: toYMD(day(-29)), to: toYMD(day(0)) };
    case 'mes':
      return { from: toYMD(new Date(now.getFullYear(), now.getMonth(), 1)), to: toYMD(day(0)) };
    case 'mesAnterior':
      return {
        from: toYMD(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: toYMD(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
  }
}
