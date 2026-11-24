import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import type { ProductDTO, VariantDTO, VariantUpdateInput } from '@pdv/shared';
import { ErrorNotice, MoneyInput } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { api } from '@/lib/api';
import { emptyVariantForm, toVariantInput, variantToForm } from '@/lib/variantForm';
import type { VariantForm } from '@/lib/variantForm';

/** Campos comuns de variante, reutilizados no cadastro de produto e nos diálogos. */
export function VariantFields({
  value,
  onChange,
  idPrefix,
  showInitialStock,
}: {
  value: VariantForm;
  onChange: (next: VariantForm) => void;
  idPrefix: string;
  showInitialStock: boolean;
}) {
  const set = (key: keyof VariantForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: e.target.value });
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Field label="SKU *" htmlFor={id('sku')} className="col-span-2">
        <Input id={id('sku')} value={value.sku} onChange={set('sku')} maxLength={64} />
      </Field>
      <Field label="Código de barras" htmlFor={id('barcode')} className="col-span-2">
        <Input id={id('barcode')} value={value.barcode} onChange={set('barcode')} maxLength={64} />
      </Field>
      <Field label="Tamanho" htmlFor={id('size')}>
        <Input id={id('size')} value={value.size} onChange={set('size')} maxLength={20} />
      </Field>
      <Field label="Cor" htmlFor={id('color')}>
        <Input id={id('color')} value={value.color} onChange={set('color')} maxLength={40} />
      </Field>
      <Field label="Preço (R$) *" htmlFor={id('price')}>
        <MoneyInput id={id('price')} value={value.price} onChange={set('price')} />
      </Field>
      <Field label="Custo (R$)" htmlFor={id('cost')}>
        <MoneyInput id={id('cost')} value={value.cost} onChange={set('cost')} />
      </Field>
      <Field label="Estoque mínimo" htmlFor={id('min')}>
        <Input
          id={id('min')}
          inputMode="numeric"
          value={value.minStock}
          onChange={set('minStock')}
        />
      </Field>
      {showInitialStock && (
        <Field label="Estoque inicial" htmlFor={id('initial')}>
          <Input
            id={id('initial')}
            inputMode="numeric"
            value={value.initialStock}
            onChange={set('initialStock')}
          />
        </Field>
      )}
    </div>
  );
}

export function AddVariantDialog({
  product,
  open,
  onOpenChange,
}: {
  product: ProductDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<VariantForm>(emptyVariantForm());
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: unknown) =>
      api<{ product: ProductDTO }>(`/products/${product.id}/variants`, { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Variante adicionada');
      setForm(emptyVariantForm());
      void queryClient.invalidateQueries({ queryKey: ['product', product.id] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      onOpenChange(false);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = toVariantInput(form);
    setFormError(parsed.ok ? null : parsed.error);
    if (parsed.ok) mutation.mutate(parsed.value);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Nova variante" description={`Produto: ${product.name}`}>
        <form onSubmit={onSubmit} className="space-y-4">
          <VariantFields value={form} onChange={setForm} idPrefix="add" showInitialStock />
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <ErrorNotice error={mutation.error} />
          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? 'Salvando…' : 'Adicionar variante'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditVariantDialog({
  variant,
  productId,
  open,
  onOpenChange,
}: {
  variant: VariantDTO;
  productId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<VariantForm>(() => variantToForm(variant));
  const [active, setActive] = useState(variant.active);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: VariantUpdateInput) =>
      api<{ variant: VariantDTO }>(`/variants/${variant.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      toast.success('Variante atualizada');
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      onOpenChange(false);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = toVariantInput(form);
    if (!parsed.ok) return setFormError(parsed.error);
    setFormError(null);
    mutation.mutate({
      sku: parsed.value.sku,
      barcode: parsed.value.barcode ?? null,
      size: parsed.value.size ?? null,
      color: parsed.value.color ?? null,
      priceCents: parsed.value.priceCents,
      costCents: parsed.value.costCents,
      minStock: parsed.value.minStock,
      active,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Editar variante"
        description="O estoque não é editado aqui: use entrada ou ajuste, que ficam registrados no histórico."
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <VariantFields value={form} onChange={setForm} idPrefix="edit" showInitialStock={false} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Variante ativa
          </label>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <ErrorNotice error={mutation.error} />
          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? 'Salvando…' : 'Salvar'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
