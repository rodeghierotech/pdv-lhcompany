import { describe, expect, it } from 'vitest';
import { isRealDate } from './schemas.js';
import { csvCell, csvMoney, csvRow, daysInRange, reportRangeSchema } from './reports.js';

describe('relatórios (puro)', () => {
  it('conta dias inclusive e valida o período', () => {
    expect(daysInRange('2026-11-01', '2026-11-01')).toBe(1);
    expect(daysInRange('2026-11-01', '2026-11-30')).toBe(30);
    expect(reportRangeSchema.safeParse({}).success).toBe(true);
    expect(reportRangeSchema.safeParse({ from: '2026-11-10', to: '2026-11-01' }).success).toBe(
      false,
    );
    expect(reportRangeSchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(
      false,
    );
    expect(reportRangeSchema.safeParse({ from: '2025-01-01', to: '2026-12-31' }).success).toBe(
      false,
    );
  });

  it('rejeita datas que o JS rolaria para o mês seguinte', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
  });

  it('CSV neutraliza fórmulas e protege separadores', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+55 11')).toBe("'+55 11");
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('linha1\nlinha2')).toBe('"linha1\nlinha2"');
    expect(csvCell(null)).toBe('');
    expect(csvRow(['A', 1, null])).toBe('A;1;');
  });

  it('formata centavos em pt-BR', () => {
    expect(csvMoney(12345)).toBe('123,45');
    expect(csvMoney(5)).toBe('0,05');
    expect(csvMoney(-250)).toBe('-2,50');
  });
});
