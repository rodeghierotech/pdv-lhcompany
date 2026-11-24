import { parseBRLToCents, variantCreateSchema } from '@pdv/shared';
import type { VariantCreateInput, VariantDTO } from '@pdv/shared';

export interface VariantForm {
  sku: string;
  barcode: string;
  size: string;
  color: string;
  price: string;
  cost: string;
  initialStock: string;
  minStock: string;
}

export const emptyVariantForm = (): VariantForm => ({
  sku: '',
  barcode: '',
  size: '',
  color: '',
  price: '',
  cost: '',
  initialStock: '',
  minStock: '',
});

export const centsToInput = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',');

export function variantToForm(v: VariantDTO): VariantForm {
  return {
    sku: v.sku,
    barcode: v.barcode ?? '',
    size: v.size ?? '',
    color: v.color ?? '',
    price: centsToInput(v.priceCents),
    cost: centsToInput(v.costCents),
    initialStock: '',
    minStock: String(v.minStock),
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function toInt(text: string, label: string): Result<number> {
  if (text.trim() === '') return { ok: true, value: 0 };
  if (!/^\d+$/.test(text.trim()))
    return { ok: false, error: `${label}: informe um número inteiro` };
  return { ok: true, value: Number(text.trim()) };
}

function toMoney(text: string, label: string, required: boolean): Result<number> {
  if (text.trim() === '') {
    return required ? { ok: false, error: `${label}: obrigatório` } : { ok: true, value: 0 };
  }
  const cents = parseBRLToCents(text);
  return cents === null
    ? { ok: false, error: `${label}: valor inválido` }
    : { ok: true, value: cents };
}

/** Converte o formulário (texto) em payload validado. Mensagens em português para o operador. */
export function toVariantInput(f: VariantForm): Result<VariantCreateInput> {
  if (!f.sku.trim()) return { ok: false, error: 'SKU: obrigatório' };
  const price = toMoney(f.price, 'Preço', true);
  if (!price.ok) return price;
  const cost = toMoney(f.cost, 'Custo', false);
  if (!cost.ok) return cost;
  const stock = toInt(f.initialStock, 'Estoque inicial');
  if (!stock.ok) return stock;
  const min = toInt(f.minStock, 'Estoque mínimo');
  if (!min.ok) return min;

  const parsed = variantCreateSchema.safeParse({
    sku: f.sku,
    barcode: f.barcode,
    size: f.size,
    color: f.color,
    priceCents: price.value,
    costCents: cost.value,
    initialStock: stock.value,
    minStock: min.value,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join('.') ?? 'Dados'}: ${issue?.message ?? 'inválido'}`,
    };
  }
  return { ok: true, value: parsed.data };
}
