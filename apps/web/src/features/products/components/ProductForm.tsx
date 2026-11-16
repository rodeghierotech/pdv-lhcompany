import { CreateProductCommandSchema, type CreateProductCommand } from "@lh-company/contracts";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../components/shared/Button";
import { FeedbackMessage } from "../../../components/shared/FeedbackMessage";
import { TextField, type TextFieldProps } from "../../../components/shared/TextField";
import { ApiError } from "../../../lib/api-client";
import { parseBrazilianMoneyToCents } from "../../../lib/money";

export interface ProductFormProps {
  onSubmit: (command: CreateProductCommand) => Promise<void>;
  onCancel: () => void;
  operationIdFactory?: () => string;
}

interface AttributeDraft { key: number; name: string; value: string }
interface VariantDraft {
  key: number;
  sku: string;
  barcode: string;
  attributes: AttributeDraft[];
  salePriceInCents: string;
  costInCents: string;
  minimumStockQuantity: string;
  tracksInventory: boolean;
  active: boolean;
}
type Errors = Record<string, string>;

const newVariant = (key: number): VariantDraft => ({
  key, sku: "", barcode: "", attributes: [], salePriceInCents: "", costInCents: "",
  minimumStockQuantity: "3", tracksInventory: true, active: true,
});
const fieldMessages: Record<string, string> = {
  name: "Informe o nome (até 180 caracteres).",
  description: "Use até 4.000 caracteres na descrição.",
  category: "Use até 120 caracteres na categoria.",
  sku: "Informe o SKU (até 100 caracteres).",
  barcode: "Use até 100 caracteres no código de barras.",
  salePriceInCents: "Informe um preço como 189,90, sem sinal ou símbolo de moeda.",
  costInCents: "Informe um custo como 80,00, sem sinal ou símbolo de moeda.",
  minimumStockQuantity: "Informe um número inteiro maior ou igual a zero.",
};

export function ProductForm({ onSubmit, onCancel, operationIdFactory = () => crypto.randomUUID() }: ProductFormProps) {
  const [operationId] = useState(operationIdFactory);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [active, setActive] = useState(true);
  const [variants, setVariants] = useState<VariantDraft[]>(() => [newVariant(0)]);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<{ message: string; reconcile: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const submitting = useRef(false);
  const serial = useRef(1);
  const form = useRef<HTMLFormElement>(null);
  const prefix = useId();

  useEffect(() => {
    if (Object.keys(errors).length) form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  function updateVariant(key: number, patch: Partial<VariantDraft>) {
    setVariants((current) => current.map((variant) => variant.key === key ? { ...variant, ...patch } : variant));
  }

  function addAttributes(variant: VariantDraft, shortcuts: boolean) {
    const additions = shortcuts
      ? ["Cor", "Tamanho"].filter((attribute) => !variant.attributes.some(({ name: label }) => label.trim().toLocaleLowerCase("pt-BR") === attribute.toLocaleLowerCase("pt-BR")))
      : [""];
    updateVariant(variant.key, { attributes: [...variant.attributes, ...additions.map((label) => ({ key: serial.current++, name: label, value: "" }))] });
  }

  function errorProps(path: string): Pick<TextFieldProps, "error"> {
    const error = errors[path];
    return error ? { error } : {};
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || complete || failure?.reconcile) return;
    const nextErrors: Errors = {};
    const money = (value: string, path: string, field: string) => {
      try { return parseBrazilianMoneyToCents(value); }
      catch { nextErrors[path] = fieldMessages[field] ?? "Confira o valor."; return NaN; }
    };
    const input = {
      operationId,
      product: { name, description: description.trim() || null, category: category.trim() || null, active,
        variants: variants.map((variant, index) => {
          const path = `product.variants.${index}`;
          const minimum = /^\d+$/.test(variant.minimumStockQuantity.trim()) ? Number(variant.minimumStockQuantity) : NaN;
          if (!Number.isSafeInteger(minimum)) nextErrors[`${path}.minimumStockQuantity`] = fieldMessages.minimumStockQuantity!;
          return {
            sku: variant.sku, barcode: variant.barcode.trim() || null,
            attributes: variant.attributes.map(({ name: attributeName, value }) => ({ name: attributeName, value })),
            salePriceInCents: money(variant.salePriceInCents, `${path}.salePriceInCents`, "salePriceInCents"),
            costInCents: money(variant.costInCents, `${path}.costInCents`, "costInCents"),
            minimumStockQuantity: minimum, tracksInventory: variant.tracksInventory, active: variant.active,
          };
        }),
      },
    };
    const parsed = CreateProductCommandSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join(".");
        const field = String(issue.path.at(-1));
        nextErrors[path] ??= path.includes(".attributes.")
          ? (field === "name" ? "Informe o nome do atributo (até 80 caracteres)." : "Informe o valor do atributo (até 120 caracteres).")
          : fieldMessages[field] ?? "Confira este campo.";
      }
    }
    setErrors(nextErrors);
    if (!parsed.success || Object.keys(nextErrors).length) return;
    submitting.current = true;
    setPending(true);
    setFailure(null);
    try {
      await onSubmit(parsed.data);
      setComplete(true);
    } catch (error: unknown) {
      const reconcile = error instanceof ApiError && error.code === "OPERATION_PAYLOAD_CONFLICT";
      setFailure({
        message: reconcile
          ? "Este cadastro pode ter sido confirmado com dados diferentes. Volte ao catálogo, atualize os dados e confira o produto e os SKUs antes de iniciar outro cadastro."
          : error instanceof ApiError ? error.message : "Não foi possível concluir o cadastro. Seus campos foram preservados; tente novamente.",
        reconcile,
      });
      submitting.current = false;
    } finally { setPending(false); }
  }

  const checkboxClass = "size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  const checkboxLabelClass = "flex min-h-11 items-center gap-2 text-sm";

  return (
    <form ref={form} aria-label="Cadastro de produto" onSubmit={(event) => { void submit(event); }} noValidate className="space-y-5">
      <p className="text-sm text-muted-foreground">Produto e variantes serão cadastrados juntos no servidor. O saldo inicial é zero; entradas de estoque são registradas por reposição.</p>
      {failure && <div className="space-y-3">
        <FeedbackMessage variant="error">{failure.message}</FeedbackMessage>
        {failure.reconcile && <Button variant="secondary" onClick={onCancel}>Voltar ao catálogo e atualizar</Button>}
      </div>}
      <fieldset disabled={pending || complete} className="min-w-0 space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2"><TextField label="Nome do produto" value={name} onChange={(event) => setName(event.target.value)} {...errorProps("product.name")} required maxLength={180} /></div>
          <TextField label="Descrição" value={description} onChange={(event) => setDescription(event.target.value)} {...errorProps("product.description")} maxLength={4000} />
          <TextField label="Categoria" value={category} onChange={(event) => setCategory(event.target.value)} {...errorProps("product.category")} maxLength={120} />
          <label className={checkboxLabelClass}><input type="checkbox" className={checkboxClass} checked={active} onChange={(event) => setActive(event.target.checked)} />Produto ativo</label>
        </div>
        <div className="space-y-5">
          {variants.map((variant, index) => {
            const path = `product.variants.${index}`;
            const fieldId = `${prefix}-variant-${variant.key}`;
            return <fieldset key={variant.key} className="min-w-0 space-y-4 border-t border-border pt-4">
              <legend className="px-1 text-base font-semibold">Variante {index + 1}</legend>
              <div className="flex justify-end"><Button variant="ghost" disabled={variants.length === 1} onClick={() => {
                setVariants((current) => current.filter(({ key }) => key !== variant.key)); setErrors({});
              }}><Trash2 aria-hidden="true" className="size-4" />Remover variante</Button></div>
              <div className="grid gap-4 md:grid-cols-2">
                <TextField id={`${fieldId}-sku`} label="SKU" value={variant.sku} onChange={(event) => updateVariant(variant.key, { sku: event.target.value })} {...errorProps(`${path}.sku`)} required maxLength={100} autoComplete="off" />
                <TextField label="Código de barras" value={variant.barcode} onChange={(event) => updateVariant(variant.key, { barcode: event.target.value })} {...errorProps(`${path}.barcode`)} maxLength={100} autoComplete="off" />
                <TextField label="Preço de venda (R$)" inputMode="decimal" value={variant.salePriceInCents} onChange={(event) => updateVariant(variant.key, { salePriceInCents: event.target.value })} {...errorProps(`${path}.salePriceInCents`)} required placeholder="189,90" />
                <TextField label="Custo (R$)" inputMode="decimal" value={variant.costInCents} onChange={(event) => updateVariant(variant.key, { costInCents: event.target.value })} {...errorProps(`${path}.costInCents`)} required placeholder="80,00" />
                <TextField label="Estoque mínimo" inputMode="numeric" value={variant.minimumStockQuantity} onChange={(event) => updateVariant(variant.key, { minimumStockQuantity: event.target.value })} {...errorProps(`${path}.minimumStockQuantity`)} required hint="Alerta de estoque baixo; não altera o saldo." />
                <div>
                  <label className={checkboxLabelClass}><input type="checkbox" className={checkboxClass} checked={variant.tracksInventory} onChange={(event) => updateVariant(variant.key, { tracksInventory: event.target.checked })} />Controlar estoque</label>
                  <label className={checkboxLabelClass}><input type="checkbox" className={checkboxClass} checked={variant.active} onChange={(event) => updateVariant(variant.key, { active: event.target.checked })} />Variante ativa</label>
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-sm font-medium">Atributos da variante</p>
                {variant.attributes.map((attribute, attributeIndex) => {
                  const attributePath = `${path}.attributes.${attributeIndex}`;
                  return <div key={attribute.key} className="grid items-start gap-3 md:grid-cols-2">
                    <TextField label={`Nome do atributo ${attributeIndex + 1}`} value={attribute.name} onChange={(event) => updateVariant(variant.key, { attributes: variant.attributes.map((item) => item.key === attribute.key ? { ...item, name: event.target.value } : item) })} {...errorProps(`${attributePath}.name`)} required maxLength={80} />
                    <div className="space-y-2">
                      <TextField label={`Valor do atributo ${attributeIndex + 1}`} value={attribute.value} onChange={(event) => updateVariant(variant.key, { attributes: variant.attributes.map((item) => item.key === attribute.key ? { ...item, value: event.target.value } : item) })} {...errorProps(`${attributePath}.value`)} required maxLength={120} />
                      <Button variant="ghost" aria-label={`Remover atributo ${attributeIndex + 1}`} onClick={() => { updateVariant(variant.key, { attributes: variant.attributes.filter(({ key }) => key !== attribute.key) }); setErrors({}); }}><Trash2 aria-hidden="true" className="size-4" />Remover atributo</Button>
                    </div>
                  </div>;
                })}
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => addAttributes(variant, true)}>Adicionar Cor/Tamanho</Button>
                  <Button variant="ghost" onClick={() => addAttributes(variant, false)}><Plus aria-hidden="true" className="size-4" />Adicionar atributo</Button>
                </div>
              </div>
            </fieldset>;
          })}
        </div>
        <Button variant="secondary" onClick={() => setVariants((current) => [...current, newVariant(serial.current++)])}><Plus aria-hidden="true" className="size-4" />Adicionar variante</Button>
        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <Button type="submit" loading={pending} disabled={Boolean(failure?.reconcile)}>Salvar produto</Button>
          <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
        </div>
      </fieldset>
    </form>
  );
}
