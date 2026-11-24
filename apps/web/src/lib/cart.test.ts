import { describe, expect, it } from 'vitest';
import type { SellableVariantDTO } from '@pdv/shared';
import { cartReducer, cartTotals, discountBasisPoints } from './cart.js';
import type { CartLine } from './cart.js';

const variant = (over: Partial<SellableVariantDTO> = {}): SellableVariantDTO => ({
  variantId: 'v1',
  productId: 'p1',
  productName: 'Camiseta',
  sku: 'CAM-P',
  barcode: null,
  size: 'P',
  color: 'Preta',
  priceCents: 8990,
  stock: 3,
  ...over,
});

const add = (lines: CartLine[], v = variant()) => cartReducer(lines, { type: 'add', variant: v });

describe('carrinho', () => {
  it('adiciona item e incrementa a quantidade ao adicionar de novo', () => {
    const once = add([]);
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ quantity: 1, unitPriceCents: 8990, discountCents: 0 });
    expect(add(once)[0]?.quantity).toBe(2);
  });

  it('nunca passa do estoque disponível', () => {
    let lines = add([], variant({ stock: 2 }));
    lines = add(lines, variant({ stock: 2 }));
    lines = add(lines, variant({ stock: 2 }));
    expect(lines[0]?.quantity).toBe(2);
    expect(
      cartReducer(lines, { type: 'setQuantity', variantId: 'v1', quantity: 99 })[0]?.quantity,
    ).toBe(2);
  });

  it('não adiciona produto sem estoque', () => {
    expect(add([], variant({ stock: 0 }))).toEqual([]);
  });

  it('quantidade inválida volta para 1', () => {
    const lines = add([]);
    expect(
      cartReducer(lines, { type: 'setQuantity', variantId: 'v1', quantity: 0 })[0]?.quantity,
    ).toBe(1);
    expect(
      cartReducer(lines, { type: 'setQuantity', variantId: 'v1', quantity: Number.NaN })[0]
        ?.quantity,
    ).toBe(1);
  });

  it('desconto não excede o valor do item e é reajustado se a quantidade diminuir', () => {
    let lines = add([], variant({ stock: 5 }));
    lines = cartReducer(lines, { type: 'setQuantity', variantId: 'v1', quantity: 3 });
    lines = cartReducer(lines, { type: 'setDiscount', variantId: 'v1', discountCents: 999_999 });
    expect(lines[0]?.discountCents).toBe(3 * 8990);
    lines = cartReducer(lines, { type: 'setQuantity', variantId: 'v1', quantity: 1 });
    expect(lines[0]?.discountCents).toBe(8990);
    expect(
      cartReducer(lines, { type: 'setDiscount', variantId: 'v1', discountCents: -5 })[0]
        ?.discountCents,
    ).toBe(0);
  });

  it('aplica percentual a todos os itens com arredondamento ao centavo', () => {
    let lines = add([], variant({ stock: 5 }));
    lines = add(lines, variant({ variantId: 'v2', sku: 'B', priceCents: 1999, stock: 5 }));
    lines = cartReducer(lines, { type: 'setDiscountAll', basisPoints: 1000 });
    expect(lines.map((l) => l.discountCents)).toEqual([899, 200]);
    expect(cartTotals(lines)).toEqual({
      subtotalCents: 10989,
      discountCents: 1099,
      totalCents: 9890,
    });
  });

  it('atualiza preços após "preço alterado" mantendo o desconto válido', () => {
    let lines = add([], variant({ priceCents: 1000 }));
    lines = cartReducer(lines, { type: 'setDiscount', variantId: 'v1', discountCents: 1000 });
    lines = cartReducer(lines, {
      type: 'refreshPrices',
      prices: [{ variantId: 'v1', priceCents: 500 }],
    });
    expect(lines[0]).toMatchObject({ unitPriceCents: 500, discountCents: 500 });
  });

  it('remove e limpa', () => {
    const lines = add(add([]), variant({ variantId: 'v2', sku: 'B' }));
    expect(cartReducer(lines, { type: 'remove', variantId: 'v1' }).map((l) => l.variantId)).toEqual(
      ['v2'],
    );
    expect(cartReducer(lines, { type: 'clear' })).toEqual([]);
  });

  it('calcula o percentual de desconto arredondando para cima (conservador contra o limite)', () => {
    expect(discountBasisPoints(1000, 10000)).toBe(1000);
    expect(discountBasisPoints(1, 10000)).toBe(1);
    expect(discountBasisPoints(0, 0)).toBe(0);
  });
});
