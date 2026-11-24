import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { CategoryDTO, ProductDTO } from '@pdv/shared';
import { ErrorNotice, PageHeader } from '@/components/shared';
import { VariantFields } from '@/components/VariantDialogs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/display';
import { Field, Input, Select } from '@/components/ui/form';
import { api } from '@/lib/api';
import { newIdempotencyKey } from '@/lib/utils';
import { emptyVariantForm, toVariantInput } from '@/lib/variantForm';
import type { VariantForm } from '@/lib/variantForm';

export function ProductFormPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Uma chave por tela aberta: reenviar o formulário (ex.: clique duplo, rede instável) não duplica.
  const idempotencyKey = useRef(newIdempotencyKey());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [variants, setVariants] = useState<VariantForm[]>([emptyVariantForm()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState('');

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<{ items: CategoryDTO[] }>('/categories'),
  });

  const addCategory = useMutation({
    mutationFn: (catName: string) =>
      api<{ category: CategoryDTO }>('/categories', { method: 'POST', body: { name: catName } }),
    onSuccess: ({ category }) => {
      setNewCategory('');
      setCategoryId(category.id);
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
    },
  });

  const create = useMutation({
    mutationFn: (body: unknown) =>
      api<{ product: ProductDTO }>('/products', { method: 'POST', body }),
    onSuccess: ({ product }) => {
      toast.success('Produto cadastrado');
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['low-stock'] });
      navigate(`/produtos/${product.id}`);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setFormError('Nome: informe ao menos 2 caracteres');
    const parsed = [];
    for (const [i, form] of variants.entries()) {
      const result = toVariantInput(form);
      if (!result.ok) return setFormError(`Variante ${i + 1} — ${result.error}`);
      parsed.push(result.value);
    }
    const skus = parsed.map((v) => v.sku.toLowerCase());
    if (new Set(skus).size !== skus.length)
      return setFormError('Há SKUs repetidos entre as variantes');
    setFormError(null);
    create.mutate({
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(categoryId ? { categoryId } : {}),
      variants: parsed,
      idempotencyKey: idempotencyKey.current,
    });
  }

  return (
    <>
      <PageHeader title="Novo produto" />
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Dados do produto</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome *" htmlFor="name" className="sm:col-span-2">
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={160}
                autoFocus
              />
            </Field>
            <Field label="Categoria" htmlFor="category">
              <Select
                id="category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">Sem categoria</option>
                {categories.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Nova categoria" htmlFor="new-category">
              <div className="flex gap-2">
                <Input
                  id="new-category"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  maxLength={80}
                />
                <Button
                  variant="outline"
                  disabled={newCategory.trim().length < 2 || addCategory.isPending}
                  onClick={() => addCategory.mutate(newCategory.trim())}
                >
                  Criar
                </Button>
              </div>
            </Field>
            <Field label="Descrição" htmlFor="description" className="sm:col-span-2">
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={1000}
              />
            </Field>
            <div className="sm:col-span-2">
              <ErrorNotice error={addCategory.error} />
            </div>
          </CardContent>
        </Card>

        {variants.map((variant, i) => (
          <Card key={i}>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Variante {i + 1}</CardTitle>
              {variants.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remover variante ${i + 1}`}
                  onClick={() => setVariants(variants.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <VariantFields
                idPrefix={`v${i}`}
                showInitialStock
                value={variant}
                onChange={(next) => setVariants(variants.map((v, j) => (j === i ? next : v)))}
              />
            </CardContent>
          </Card>
        ))}

        <Button variant="outline" onClick={() => setVariants([...variants, emptyVariantForm()])}>
          <Plus /> Adicionar variante
        </Button>

        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}
        <ErrorNotice error={create.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Salvando…' : 'Cadastrar produto'}
          </Button>
          <Button variant="ghost" onClick={() => navigate('/produtos')}>
            Cancelar
          </Button>
        </div>
      </form>
    </>
  );
}
