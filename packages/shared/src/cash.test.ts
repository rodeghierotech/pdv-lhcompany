import { describe, expect, it } from 'vitest';
import { allocateReceipt } from './cash.js';

describe('allocateReceipt', () => {
  const sales = [
    { saleId: 'a', balanceCents: 3000 },
    { saleId: 'b', balanceCents: 2000 },
  ];
  it('quita a venda mais antiga primeiro', () => {
    expect(allocateReceipt([{ method: 'pix', amountCents: 2500 }], sales)).toEqual([
      { saleId: 'a', method: 'pix', amountCents: 2500 },
    ]);
  });
  it('fatia um pagamento entre vendas e preserva o total', () => {
    const out = allocateReceipt([{ method: 'dinheiro', amountCents: 4000 }], sales)!;
    expect(out).toEqual([
      { saleId: 'a', method: 'dinheiro', amountCents: 3000 },
      { saleId: 'b', method: 'dinheiro', amountCents: 1000 },
    ]);
  });
  it('pagamento misto: soma por modalidade é preservada', () => {
    const out = allocateReceipt(
      [
        { method: 'dinheiro', amountCents: 3500 },
        { method: 'pix', amountCents: 1500 },
      ],
      sales,
    )!;
    const sum = (m: string) =>
      out.filter((x) => x.method === m).reduce((s, x) => s + x.amountCents, 0);
    expect(sum('dinheiro')).toBe(3500);
    expect(sum('pix')).toBe(1500);
    expect(out.reduce((s, x) => s + x.amountCents, 0)).toBe(5000);
  });
  it('rejeita pagamento acima do saldo', () => {
    expect(allocateReceipt([{ method: 'pix', amountCents: 5001 }], sales)).toBeNull();
    expect(allocateReceipt([{ method: 'pix', amountCents: 1 }], [])).toBeNull();
  });
});
