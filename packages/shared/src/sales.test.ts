import { describe, expect, it } from 'vitest';
import {
  balanceOf,
  computeReturnEffect,
  computeSaleTotals,
  isDiscountWithinLimit,
  paymentStatusOf,
  percentToCents,
  returnItemAmountCents,
} from './sales.js';

describe('totais da venda', () => {
  it('soma subtotal, desconto e total', () => {
    expect(
      computeSaleTotals([
        { quantity: 2, unitPriceCents: 8990, discountCents: 1000 },
        { quantity: 1, unitPriceCents: 15000, discountCents: 0 },
      ]),
    ).toEqual({ subtotalCents: 32980, discountCents: 1000, totalCents: 31980 });
  });
});

describe('limite de desconto', () => {
  it('compara em inteiros', () => {
    expect(isDiscountWithinLimit(1000, 10000, 1000)).toBe(true); // 10% de 100,00
    expect(isDiscountWithinLimit(1001, 10000, 1000)).toBe(false);
    expect(isDiscountWithinLimit(0, 10000, 0)).toBe(true);
    expect(isDiscountWithinLimit(1, 10000, 0)).toBe(false);
  });
  it('percentual arredonda ao centavo', () => {
    expect(percentToCents(1999, 1000)).toBe(200);
  });
});

describe('estado do pagamento', () => {
  it.each([
    [10000, 0, 10000, 'pago'],
    [10000, 0, 0, 'fiado'],
    [10000, 0, 4000, 'parcial'],
    [10000, 10000, 0, 'pago'], // tudo devolvido
    [0, 0, 0, 'pago'], // venda de valor zero
  ])('total %i devolvido %i recebido %i -> %s', (t, r, p, expected) => {
    expect(paymentStatusOf(t, r, p)).toBe(expected);
  });
  it('saldo nunca fica negativo', () => {
    expect(balanceOf(10000, 0, 12000)).toBe(0);
    expect(balanceOf(10000, 2000, 3000)).toBe(5000);
  });
});

describe('devolução parcial', () => {
  it('soma das devoluções parciais é exatamente o total da linha', () => {
    // 3 unidades, total 100,00 (10000): 3333 + 3334 + 3333 (por acumulado)
    const qty = 3;
    const total = 10000;
    let returned = 0;
    let sum = 0;
    for (let i = 0; i < qty; i++) {
      sum += returnItemAmountCents(total, qty, returned, 1);
      returned += 1;
    }
    expect(sum).toBe(total);
  });
  it('devolver tudo de uma vez devolve o total', () => {
    expect(returnItemAmountCents(9999, 7, 0, 7)).toBe(9999);
  });
  it('independe da ordem/agrupamento das devoluções', () => {
    const a = returnItemAmountCents(9999, 7, 0, 3) + returnItemAmountCents(9999, 7, 3, 4);
    expect(a).toBe(9999);
  });
});

describe('efeito financeiro da devolução', () => {
  it('venda paga integralmente: reembolsa o valor devolvido', () => {
    expect(
      computeReturnEffect({
        totalCents: 10000,
        returnedBeforeCents: 0,
        receivedCents: 10000,
        valueCents: 4000,
      }),
    ).toEqual({ valueCents: 4000, refundDueCents: 4000, debtReductionCents: 0 });
  });
  it('venda fiada: apenas abate o saldo, sem reembolso', () => {
    expect(
      computeReturnEffect({
        totalCents: 10000,
        returnedBeforeCents: 0,
        receivedCents: 0,
        valueCents: 4000,
      }),
    ).toEqual({ valueCents: 4000, refundDueCents: 0, debtReductionCents: 4000 });
  });
  it('venda parcial: abate o saldo primeiro e reembolsa só o excedente', () => {
    // total 100, pagou 30, deve 70; devolve 90 -> abate 70 de dívida, reembolsa 20
    expect(
      computeReturnEffect({
        totalCents: 10000,
        returnedBeforeCents: 0,
        receivedCents: 3000,
        valueCents: 9000,
      }),
    ).toEqual({ valueCents: 9000, refundDueCents: 2000, debtReductionCents: 7000 });
  });
  it('devolução menor que o saldo devedor não gera reembolso', () => {
    expect(
      computeReturnEffect({
        totalCents: 10000,
        returnedBeforeCents: 0,
        receivedCents: 3000,
        valueCents: 5000,
      }),
    ).toEqual({ valueCents: 5000, refundDueCents: 0, debtReductionCents: 5000 });
  });
});
