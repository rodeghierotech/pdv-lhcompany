import { describe, expect, it } from 'vitest';
import { presetRange, toYMD } from './periods.js';

describe('períodos do painel', () => {
  const now = new Date(2026, 2, 15, 23, 30); // 15/03/2026 à noite (local)
  it('usa o calendário local, mesmo à noite', () => {
    expect(toYMD(now)).toBe('2026-03-15');
    expect(presetRange('hoje', now)).toEqual({ from: '2026-03-15', to: '2026-03-15' });
  });
  it('janelas móveis incluem hoje', () => {
    expect(presetRange('7dias', now)).toEqual({ from: '2026-03-09', to: '2026-03-15' });
    expect(presetRange('30dias', now)).toEqual({ from: '2026-02-14', to: '2026-03-15' });
  });
  it('mês atual e anterior (inclusive virada de ano e fevereiro)', () => {
    expect(presetRange('mes', now)).toEqual({ from: '2026-03-01', to: '2026-03-15' });
    expect(presetRange('mesAnterior', now)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('mesAnterior', new Date(2026, 0, 10))).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });
});
