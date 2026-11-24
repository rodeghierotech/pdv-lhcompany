import { computeSaleTotals, lineGrossCents, MAX_ITEM_QUANTITY } from '@pdv/shared';
import type { SellableVariantDTO } from '@pdv/shared';

/**
 * Estado do carrinho (apenas apresentação/prévia). O servidor revalida tudo: preço, estoque,
 * desconto e totais. Aqui só evitamos erros óbvios antes de enviar.
 */
export interface CartLine {
  variantId: string;
  sku: string;
  productName: string;
  size: string | null;
  color: string | null;
  unitPriceCents: number;
  stock: number;
  quantity: number;
  discountCents: number;
}

export type CartAction =
  | { type: 'add'; variant: SellableVariantDTO }
  | { type: 'setQuantity'; variantId: string; quantity: number }
  | { type: 'setDiscount'; variantId: string; discountCents: number }
  | { type: 'setDiscountAll'; basisPoints: number }
  | { type: 'refreshPrices'; prices: { variantId: string; priceCents: number }[] }
  | { type: 'remove'; variantId: string }
  | { type: 'clear' };

const maxQuantity = (line: Pick<CartLine, 'stock'>) => Math.min(line.stock, MAX_ITEM_QUANTITY);

/** Mantém o desconto dentro do valor bruto do item (nunca negativo, nunca acima do item). */
function clampDiscount(line: CartLine): CartLine {
  const gross = lineGrossCents(line);
  const discountCents = Math.min(Math.max(line.discountCents, 0), gross);
  return discountCents === line.discountCents ? line : { ...line, discountCents };
}

export function cartReducer(lines: CartLine[], action: CartAction): CartLine[] {
  switch (action.type) {
    case 'add': {
      const v = action.variant;
      if (v.stock <= 0) return lines;
      const existing = lines.find((l) => l.variantId === v.variantId);
      if (existing) {
        return lines.map((l) =>
          l.variantId === v.variantId
            ? clampDiscount({
                ...l,
                stock: v.stock,
                quantity: Math.min(l.quantity + 1, maxQuantity({ stock: v.stock })),
              })
            : l,
        );
      }
      return [
        ...lines,
        {
          variantId: v.variantId,
          sku: v.sku,
          productName: v.productName,
          size: v.size,
          color: v.color,
          unitPriceCents: v.priceCents,
          stock: v.stock,
          quantity: 1,
          discountCents: 0,
        },
      ];
    }
    case 'setQuantity':
      return lines.map((l) => {
        if (l.variantId !== action.variantId) return l;
        const quantity = Math.min(Math.max(Math.trunc(action.quantity) || 1, 1), maxQuantity(l));
        return clampDiscount({ ...l, quantity });
      });
    case 'setDiscount':
      return lines.map((l) =>
        l.variantId === action.variantId
          ? clampDiscount({ ...l, discountCents: Math.round(action.discountCents) })
          : l,
      );
    case 'setDiscountAll':
      return lines.map((l) =>
        clampDiscount({
          ...l,
          discountCents: Math.round((lineGrossCents(l) * action.basisPoints) / 10_000),
        }),
      );
    case 'refreshPrices': {
      const prices = new Map(action.prices.map((p) => [p.variantId, p.priceCents]));
      return lines.map((l) =>
        prices.has(l.variantId)
          ? clampDiscount({ ...l, unitPriceCents: prices.get(l.variantId)! })
          : l,
      );
    }
    case 'remove':
      return lines.filter((l) => l.variantId !== action.variantId);
    case 'clear':
      return [];
  }
}

export function cartTotals(lines: readonly CartLine[]) {
  return computeSaleTotals(lines);
}

/** Percentual efetivo do desconto sobre o subtotal, em pontos-base (para comparar com o limite). */
export function discountBasisPoints(discountCents: number, subtotalCents: number): number {
  return subtotalCents === 0 ? 0 : Math.ceil((discountCents * 10_000) / subtotalCents);
}
