import { describe, expect, it } from 'vitest';
import { applyPercentDiscount, parseBRLToCents } from './money.js';
import { hasPermission } from './permissions.js';

describe('parseBRLToCents', () => {
  it.each([
    ['12', 1200],
    ['12,5', 1250],
    ['12,50', 1250],
    ['1.234,56', 123456],
    ['R$ 0,99', 99],
  ])('converte %s', (input, expected) => {
    expect(parseBRLToCents(input)).toBe(expected);
  });

  it.each(['', 'abc', '1,234', '12.5', '1..2', '-5'])('rejeita %j', (input) => {
    expect(parseBRLToCents(input)).toBeNull();
  });
});

describe('applyPercentDiscount', () => {
  it('arredonda ao centavo', () => {
    expect(applyPercentDiscount(1999, 1000)).toBe(1799); // 10% de 19,99 = 1,999 → 2,00
    expect(applyPercentDiscount(10000, 0)).toBe(10000);
    expect(applyPercentDiscount(10000, 10000)).toBe(0);
  });
  it('rejeita entradas inválidas', () => {
    expect(() => applyPercentDiscount(100, 10_001)).toThrow(RangeError);
    expect(() => applyPercentDiscount(-1, 10)).toThrow(RangeError);
  });
});

describe('permissões', () => {
  it('vendedor lê mas não ajusta estoque', () => {
    expect(hasPermission('vendedor', 'product:read')).toBe(true);
    expect(hasPermission('vendedor', 'stock:adjust')).toBe(false);
  });
  it('apenas admin gerencia usuários', () => {
    expect(hasPermission('admin', 'user:manage')).toBe(true);
    expect(hasPermission('gerente', 'user:manage')).toBe(false);
  });
});
