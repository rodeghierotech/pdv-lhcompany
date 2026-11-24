import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Minus, Plus, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  formatBRL,
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHODS,
  parseBRLToCents,
  percentToCents,
} from '@pdv/shared';
import type {
  CustomerDTO,
  DiscountLimitDTO,
  PaymentMethod,
  SaleDTO,
  SellableVariantDTO,
} from '@pdv/shared';
import { CustomerPicker } from '@/components/CustomerPicker';
import { ErrorNotice } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/display';
import { Input, Select } from '@/components/ui/form';
import { useAuth } from '@/hooks/useAuth';
import { useCashSession } from '@/hooks/useCashSession';
import { SyncBadge } from '@/components/SyncBadge';
import { notifyQueueChanged, subscribeQueue, useOffline } from '@/hooks/useOffline';
import { api, ApiError } from '@/lib/api';
import type { LocalOperation } from '@/lib/offline/db';
import {
  enqueueSale,
  getOperation,
  grantIsValid,
  loadCashSession,
  loadCatalogMeta,
  loadGrant,
  searchLocalVariants,
} from '@/lib/offline/store';
import { cartReducer, cartTotals, discountBasisPoints } from '@/lib/cart';
import type { CartLine } from '@/lib/cart';
import { describeApiError } from '@/lib/errors';
import { centsToInput } from '@/lib/variantForm';

interface PayRow {
  id: string;
  method: PaymentMethod;
  amount: string;
  /** Valor entregue pelo cliente (dinheiro), só para calcular o troco na tela. */
  tendered: string;
}

/** Chave única da tentativa de venda; é também o operationId caso a venda vá para a fila offline. */
const newOperationKey = () => `op:${crypto.randomUUID()}`;

/** Busca no servidor; sem conexão, cai para o catálogo local. */
async function searchVariants(q: string): Promise<SellableVariantDTO[]> {
  try {
    return (await api<{ items: SellableVariantDTO[] }>('/pos/variants', { query: { q } })).items;
  } catch (err) {
    if (err instanceof ApiError && err.isNetwork) return searchLocalVariants(q);
    throw err;
  }
}

const newRow = (method: PaymentMethod, amountCents: number): PayRow => ({
  id: crypto.randomUUID(),
  method,
  amount: amountCents > 0 ? centsToInput(amountCents) : '',
  tendered: '',
});

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** Campo de desconto em R$ por item: edita como texto e confirma ao sair do campo/Enter. */
function DiscountInput({
  cents,
  onCommit,
  label,
}: {
  cents: number;
  onCommit: (cents: number) => void;
  label: string;
}) {
  const [text, setText] = useState(cents ? centsToInput(cents) : '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(cents ? centsToInput(cents) : '');
  }, [cents]);
  const commit = () => {
    focused.current = false;
    const parsed = text.trim() === '' ? 0 : parseBRLToCents(text);
    if (parsed === null) setText(cents ? centsToInput(cents) : '');
    else onCommit(parsed);
  };
  return (
    <Input
      aria-label={label}
      inputMode="decimal"
      placeholder="0,00"
      className="h-9 w-24 text-right"
      value={text}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

const variantLabel = (l: Pick<CartLine, 'size' | 'color'>) =>
  [l.size, l.color].filter(Boolean).join(' · ');

export function PosPage() {
  const { user } = useAuth();
  const cash = useCashSession();
  const cashOpen = cash.data ? cash.data.session !== null : true;
  const [dueDate, setDueDate] = useState('');
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState('');
  const [lines, dispatch] = useReducer(cartReducer, [] as CartLine[]);
  const [customer, setCustomer] = useState<CustomerDTO | null>(null);
  const [rows, setRows] = useState<PayRow[]>([]);
  const [discountAll, setDiscountAll] = useState('');
  const [lastSale, setLastSale] = useState<{ sale: SaleDTO; changeCents: number } | null>(null);
  const [lastOffline, setLastOffline] = useState<{
    op: LocalOperation;
    changeCents: number;
  } | null>(null);
  const { online, grantValid } = useOffline();
  const [localCashId, setLocalCashId] = useState<string | null>(null);
  const [localLimitBp, setLocalLimitBp] = useState<number | null>(null);
  useEffect(() => {
    void loadCatalogMeta().then((m) => setLocalLimitBp(m?.discountLimitBp ?? null));
    void loadCashSession().then((c) =>
      setLocalCashId(c && c.userId === user?.id ? c.sessionId : null),
    );
  }, [online, cash.data, user?.id]);
  // Mantém o estado de sincronização da última venda offline atualizado na tela.
  const lastOfflineId = lastOffline?.op.operationId;
  useEffect(() => {
    if (!lastOfflineId) return;
    return subscribeQueue(() => {
      void getOperation(lastOfflineId).then(
        (op) => op && setLastOffline((c) => (c ? { ...c, op } : c)),
      );
    });
  }, [lastOfflineId]);
  // Uma chave por tentativa de venda: reenvio (rede instável/duplo clique) nunca duplica a venda.
  const idempotencyKey = useRef(newOperationKey());
  const q = useDebounced(search.trim(), 200);

  const limits = useQuery({
    queryKey: ['discount-limits'],
    queryFn: () => api<{ items: DiscountLimitDTO[] }>('/settings/discount-limits'),
    staleTime: 60_000,
  });
  const maxDiscountBp =
    limits.data?.items.find((l) => l.role === user?.role)?.maxDiscountBp ?? localLimitBp ?? 0;

  const results = useQuery({
    queryKey: ['pos-search', q],
    queryFn: async () => ({ items: await searchVariants(q) }),
    enabled: q.length >= 1,
  });

  // ----- cálculos de prévia (o servidor recalcula e valida tudo) -----
  const totals = cartTotals(lines);
  const parsedRows = rows.map((r) => ({
    row: r,
    cents: r.amount.trim() === '' ? null : parseBRLToCents(r.amount),
  }));
  const rowsValid = parsedRows.every((p) => p.cents !== null && p.cents > 0);
  const paidCents = parsedRows.reduce((sum, p) => sum + (p.cents ?? 0), 0);
  const remainingCents = totals.totalCents - paidCents;
  const overpaid = paidCents > totals.totalCents;
  const needsCustomer = lines.length > 0 && remainingCents > 0;
  const discountBp = discountBasisPoints(totals.discountCents, totals.subtotalCents);
  const discountError =
    totals.discountCents === 0
      ? null
      : maxDiscountBp === 0
        ? 'Seu perfil não pode conceder desconto.'
        : discountBp > maxDiscountBp
          ? `Desconto acima do limite de ${maxDiscountBp / 100}% do seu perfil.`
          : null;
  const paymentLabel = remainingCents <= 0 ? 'Pago' : paidCents === 0 ? 'Fiado' : 'Parcial';
  const blocker = !cashOpen
    ? 'Abra o caixa para vender'
    : !online && !grantValid
      ? 'Autorização offline ausente ou expirada. Reconecte-se para continuar vendendo.'
      : !online && !localCashId
        ? 'Sem conexão e sem caixa conhecido neste aparelho: abra o caixa online antes de vender offline.'
        : !online && lines.length > 0 && (remainingCents > 0 || !!customer)
          ? 'Sem conexão: apenas vendas pagas integralmente e sem cliente (fiado/parcial exigem o servidor).'
          : lines.length === 0
            ? 'Adicione produtos'
            : discountError
              ? discountError
              : !rowsValid
                ? 'Informe valores de pagamento válidos'
                : overpaid
                  ? 'Pagamentos maiores que o total'
                  : needsCustomer && !customer
                    ? 'Informe o cliente para fiado/parcial'
                    : null;

  // ----- ações -----
  const addVariant = useCallback((v: SellableVariantDTO) => {
    if (v.stock <= 0) {
      toast.error(`${v.productName} (${v.sku}) está sem estoque`);
      return;
    }
    setLastSale(null);
    setLastOffline(null);
    dispatch({ type: 'add', variant: v });
  }, []);

  async function onSearchEnter() {
    const text = search.trim();
    if (!text) return;
    try {
      const { items } = await queryClient.fetchQuery({
        queryKey: ['pos-search', text],
        queryFn: async () => ({ items: await searchVariants(text) }),
        staleTime: 0,
      });
      const exact = items.find(
        (v) => v.barcode === text || v.sku.toLowerCase() === text.toLowerCase(),
      );
      const pick = exact ?? (items.length === 1 ? items[0] : undefined);
      if (pick) {
        addVariant(pick);
        setSearch('');
      } else if (items.length === 0) {
        toast.error('Produto não encontrado');
      }
    } catch (err) {
      toast.error(describeApiError(err));
    }
  }

  const sale = useMutation({
    mutationFn: async (): Promise<
      { kind: 'online'; sale: SaleDTO } | { kind: 'offline'; op: LocalOperation }
    > => {
      const payload = {
        ...(dueDate && remainingCents > 0 ? { dueDate } : {}),
        ...(customer ? { customerId: customer.id } : {}),
        items: lines.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          discountCents: l.discountCents,
        })),
        payments: parsedRows.map((p) => ({ method: p.row.method, amountCents: p.cents! })),
      };
      // Venda offline: grava na fila local (nunca é apresentada como confirmada).
      const queueOffline = async () => {
        const grant = await loadGrant();
        if (!user || !grantIsValid(grant, user.id)) {
          throw new ApiError(0, 'GRANT_EXPIRED', 'Autorização offline expirada. Reconecte-se.');
        }
        const cashRef = await loadCashSession();
        if (!cashRef || cashRef.userId !== user.id) {
          throw new ApiError(
            0,
            'CASH_UNKNOWN',
            'Caixa não identificado neste aparelho. Conecte-se e abra o caixa.',
          );
        }
        const op = await enqueueSale({
          cashSessionId: cashRef.sessionId,
          operationId: idempotencyKey.current.slice(3),
          userId: user.id,
          grant: grant.grant,
          payload,
          label: `${lines.length} item(ns)`,
        });
        notifyQueueChanged();
        return { kind: 'offline' as const, op };
      };
      const offlineEligible = remainingCents <= 0 && !customer && !dueDate;
      if (!online) return queueOffline();
      try {
        const res = await api<{ sale: SaleDTO; replayed: boolean }>('/sales', {
          method: 'POST',
          body: { idempotencyKey: idempotencyKey.current, ...payload },
        });
        return { kind: 'online', sale: res.sale };
      } catch (err) {
        // A conexão caiu durante o envio: a mesma chave (op:<id>) evita venda duplicada
        // caso o servidor tenha processado a requisição sem a resposta chegar.
        if (err instanceof ApiError && err.isNetwork && offlineEligible) return queueOffline();
        throw err;
      }
    },
    onSuccess: (result) => {
      const changeCents = parsedRows.reduce((sum, p) => {
        if (p.row.method !== 'dinheiro') return sum;
        const tendered = p.row.tendered.trim() ? parseBRLToCents(p.row.tendered) : null;
        return tendered !== null && p.cents !== null && tendered > p.cents
          ? sum + (tendered - p.cents)
          : sum;
      }, 0);
      if (result.kind === 'online') {
        setLastSale({ sale: result.sale, changeCents });
        setLastOffline(null);
      } else {
        setLastOffline({ op: result.op, changeCents });
        setLastSale(null);
      }
      dispatch({ type: 'clear' });
      setRows([]);
      setCustomer(null);
      setDiscountAll('');
      setDueDate('');
      idempotencyKey.current = newOperationKey();
      for (const key of [
        'sales',
        'products',
        'product',
        'low-stock',
        'pos-search',
        'customers',
        'movements',
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      searchRef.current?.focus();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'PRICE_CHANGED' && Array.isArray(err.details)) {
        dispatch({
          type: 'refreshPrices',
          prices: (err.details as { variantId: string; currentPriceCents: number }[]).map((d) => ({
            variantId: d.variantId,
            priceCents: d.currentPriceCents,
          })),
        });
        toast.warning('Preços atualizados no carrinho. Confira os valores e finalize novamente.');
      }
      // Estoque mudou: atualiza as quantidades máximas exibidas.
      void queryClient.invalidateQueries({ queryKey: ['pos-search'] });
    },
  });

  const canFinalize = blocker === null && !sale.isPending;

  // Atalhos: F2 foca a busca, F9 finaliza.
  const finalizeRef = useRef<() => void>(() => undefined);
  finalizeRef.current = () => canFinalize && sale.mutate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'F9') {
        e.preventDefault();
        finalizeRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setSingleRow = (method: PaymentMethod) => setRows([newRow(method, totals.totalCents)]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
      {/* ---------------- Coluna esquerda: busca + carrinho ---------------- */}
      <div className="space-y-4">
        {!cashOpen && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm"
          >
            <span>Caixa fechado: abra o caixa para registrar vendas.</span>
            <Button size="sm" asChild>
              <Link to="/caixa">Abrir caixa</Link>
            </Button>
          </div>
        )}
        {lastOffline && (
          <div
            role="status"
            data-testid="offline-sale-banner"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4"
          >
            <div>
              <p className="flex items-center gap-2 font-semibold">
                Venda salva neste aparelho <SyncBadge state={lastOffline.op.state} />
              </p>
              <p className="text-sm text-muted-foreground">
                Total {formatBRL(lastOffline.op.summary.totalCents)}
                {lastOffline.changeCents > 0 && ` · troco ${formatBRL(lastOffline.changeCents)}`}
                {lastOffline.op.state === 'confirmada'
                  ? ` · confirmada pelo servidor (venda #${lastOffline.op.saleNumber})`
                  : ' · ainda NÃO confirmada pelo servidor; será enviada ao reconectar'}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/sincronizacao">Ver sincronização</Link>
              </Button>
              <Button size="sm" onClick={() => setLastOffline(null)}>
                Nova venda
              </Button>
            </div>
          </div>
        )}
        {lastSale && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/40 bg-success/10 p-4"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 className="size-6 text-success" />
              <div>
                <p className="font-semibold">Venda #{lastSale.sale.number} concluída</p>
                <p className="text-sm text-muted-foreground">
                  Total {formatBRL(lastSale.sale.totalCents)} · {lastSale.sale.paymentStatus}
                  {lastSale.sale.balanceCents > 0 &&
                    ` · a receber ${formatBRL(lastSale.sale.balanceCents)}`}
                  {lastSale.changeCents > 0 && ` · troco ${formatBRL(lastSale.changeCents)}`}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to={`/vendas/${lastSale.sale.id}`}>Ver venda</Link>
              </Button>
              <Button size="sm" onClick={() => setLastSale(null)}>
                Nova venda
              </Button>
            </div>
          </div>
        )}

        <div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input
              ref={searchRef}
              aria-label="Buscar produto"
              placeholder="Nome, SKU ou código de barras (Enter adiciona) — F2"
              className="h-11 pl-9 text-base"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void onSearchEnter()}
              autoFocus
            />
          </div>
          {q && results.data && (
            <Card className="mt-2 max-h-72 overflow-y-auto">
              {results.data.items.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">Nenhum produto encontrado.</p>
              ) : (
                <ul className="divide-y">
                  {results.data.items.map((v) => (
                    <li key={v.variantId}>
                      <button
                        type="button"
                        disabled={v.stock <= 0}
                        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => {
                          addVariant(v);
                          searchRef.current?.focus();
                        }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {v.productName}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {v.sku}
                            {variantLabel(v) && ` · ${variantLabel(v)}`}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-sm font-semibold tabular-nums">
                            {formatBRL(v.priceCents)}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {v.stock > 0 ? `${v.stock} em estoque` : 'Sem estoque'}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Carrinho</CardTitle>
            {lines.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'clear' })}>
                Limpar
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {lines.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Busque ou leia o código de barras para começar a venda.
              </p>
            ) : (
              <ul className="divide-y">
                {lines.map((l) => (
                  <li
                    key={l.variantId}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
                  >
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="truncate text-sm font-medium">{l.productName}</p>
                      <p className="text-xs text-muted-foreground">
                        {l.sku}
                        {variantLabel(l) && ` · ${variantLabel(l)}`} · {formatBRL(l.unitPriceCents)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-9"
                        aria-label={`Diminuir ${l.sku}`}
                        disabled={l.quantity <= 1}
                        onClick={() =>
                          dispatch({
                            type: 'setQuantity',
                            variantId: l.variantId,
                            quantity: l.quantity - 1,
                          })
                        }
                      >
                        <Minus />
                      </Button>
                      <Input
                        aria-label={`Quantidade ${l.sku}`}
                        inputMode="numeric"
                        className="h-9 w-14 text-center tabular-nums"
                        value={l.quantity}
                        onChange={(e) =>
                          dispatch({
                            type: 'setQuantity',
                            variantId: l.variantId,
                            quantity: Number(e.target.value),
                          })
                        }
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-9"
                        aria-label={`Aumentar ${l.sku}`}
                        disabled={l.quantity >= l.stock}
                        onClick={() =>
                          dispatch({
                            type: 'setQuantity',
                            variantId: l.variantId,
                            quantity: l.quantity + 1,
                          })
                        }
                      >
                        <Plus />
                      </Button>
                    </div>
                    {maxDiscountBp > 0 && (
                      <DiscountInput
                        label={`Desconto ${l.sku} (R$)`}
                        cents={l.discountCents}
                        onCommit={(cents) =>
                          dispatch({
                            type: 'setDiscount',
                            variantId: l.variantId,
                            discountCents: cents,
                          })
                        }
                      />
                    )}
                    <p className="w-24 text-right text-sm font-semibold tabular-nums">
                      {formatBRL(l.quantity * l.unitPriceCents - l.discountCents)}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9"
                      aria-label={`Remover ${l.sku}`}
                      onClick={() => dispatch({ type: 'remove', variantId: l.variantId })}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- Coluna direita: cliente, totais, pagamento ---------------- */}
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Cliente</CardTitle>
          </CardHeader>
          <CardContent>
            {online ? (
              <CustomerPicker value={customer} onChange={setCustomer} required={needsCustomer} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Indisponível sem conexão. Vendas offline são pagas integralmente e sem cliente.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pagamento</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular-nums">{formatBRL(totals.subtotalCents)}</dd>
              </div>
              {totals.discountCents > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">
                    Desconto ({(discountBp / 100).toFixed(1).replace('.', ',')}%)
                  </dt>
                  <dd className="tabular-nums text-destructive">
                    − {formatBRL(totals.discountCents)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between border-t pt-2 text-lg font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums" data-testid="total">
                  {formatBRL(totals.totalCents)}
                </dd>
              </div>
            </dl>

            {maxDiscountBp > 0 && lines.length > 0 && (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label htmlFor="discount-all" className="text-xs text-muted-foreground">
                    Desconto em todos os itens (%) — máx. {maxDiscountBp / 100}%
                  </label>
                  <Input
                    id="discount-all"
                    inputMode="decimal"
                    placeholder="0"
                    className="h-9"
                    value={discountAll}
                    onChange={(e) => setDiscountAll(e.target.value)}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const pct = Number(discountAll.replace(',', '.'));
                    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
                      dispatch({ type: 'setDiscountAll', basisPoints: Math.round(pct * 100) });
                    }
                  }}
                >
                  Aplicar
                </Button>
              </div>
            )}
            {discountError && (
              <p role="alert" className="text-sm text-destructive">
                {discountError}
              </p>
            )}

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Receber o total em:</p>
              <div className="grid grid-cols-2 gap-2">
                {PAYMENT_METHODS.map((m) => (
                  <Button
                    key={m}
                    variant="outline"
                    size="sm"
                    disabled={totals.totalCents === 0}
                    onClick={() => setSingleRow(m)}
                  >
                    {PAYMENT_METHOD_LABEL[m]}
                  </Button>
                ))}
              </div>
            </div>

            {rows.length > 0 && (
              <ul className="space-y-2">
                {rows.map((r, i) => (
                  <li key={r.id} className="space-y-1.5 rounded-md border p-2">
                    <div className="flex items-center gap-2">
                      <Select
                        aria-label={`Forma de pagamento ${i + 1}`}
                        className="h-9 flex-1"
                        value={r.method}
                        onChange={(e) =>
                          setRows(
                            rows.map((x) =>
                              x.id === r.id ? { ...x, method: e.target.value as PaymentMethod } : x,
                            ),
                          )
                        }
                      >
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {PAYMENT_METHOD_LABEL[m]}
                          </option>
                        ))}
                      </Select>
                      <Input
                        aria-label={`Valor ${i + 1}`}
                        inputMode="decimal"
                        placeholder="0,00"
                        className="h-9 w-28 text-right"
                        value={r.amount}
                        onChange={(e) =>
                          setRows(
                            rows.map((x) => (x.id === r.id ? { ...x, amount: e.target.value } : x)),
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9"
                        aria-label={`Remover pagamento ${i + 1}`}
                        onClick={() => setRows(rows.filter((x) => x.id !== r.id))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    {r.method === 'dinheiro' && (
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <label htmlFor={`tendered-${r.id}`}>Recebido do cliente</label>
                        <Input
                          id={`tendered-${r.id}`}
                          inputMode="decimal"
                          placeholder="0,00"
                          className="h-8 w-28 text-right"
                          value={r.tendered}
                          onChange={(e) =>
                            setRows(
                              rows.map((x) =>
                                x.id === r.id ? { ...x, tendered: e.target.value } : x,
                              ),
                            )
                          }
                        />
                        {(() => {
                          const t = r.tendered.trim() ? parseBRLToCents(r.tendered) : null;
                          const a = parsedRows[i]?.cents ?? null;
                          return t !== null && a !== null && t > a ? (
                            <span className="font-semibold text-foreground">
                              Troco {formatBRL(t - a)}
                            </span>
                          ) : null;
                        })()}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={lines.length === 0}
              onClick={() => setRows([...rows, newRow('pix', Math.max(remainingCents, 0))])}
            >
              <Plus /> Adicionar forma de pagamento
            </Button>

            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
              <span>
                Pago <strong className="tabular-nums">{formatBRL(paidCents)}</strong>
              </span>
              <span
                className={
                  remainingCents > 0
                    ? 'text-warning'
                    : overpaid
                      ? 'text-destructive'
                      : 'text-success'
                }
              >
                {overpaid
                  ? `Excede ${formatBRL(-remainingCents)}`
                  : remainingCents > 0
                    ? `Resta ${formatBRL(remainingCents)}`
                    : 'Quitado'}
              </span>
              {lines.length > 0 && (
                <Badge variant={paymentLabel === 'Pago' ? 'success' : 'warning'}>
                  {paymentLabel}
                </Badge>
              )}
            </div>
            {needsCustomer && (
              <div className="flex items-center justify-between gap-2 text-sm">
                <label htmlFor="due-date" className="text-muted-foreground">
                  Vencimento (opcional)
                </label>
                <Input
                  id="due-date"
                  type="date"
                  className="h-9 w-40"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            )}
            {needsCustomer && (
              <p className="text-xs text-muted-foreground">
                O saldo de {formatBRL(remainingCents)} será lançado como débito do cliente (sem
                juros).
              </p>
            )}

            <ErrorNotice error={sale.error} />
            <Button
              className="h-12 w-full text-base"
              disabled={!canFinalize}
              onClick={() => sale.mutate()}
            >
              {sale.isPending ? 'Registrando…' : 'Finalizar venda (F9)'}
            </Button>
            {blocker && lines.length > 0 && (
              <p className="text-center text-xs text-muted-foreground">{blocker}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// percentToCents é reexportado para facilitar testes de prévia no futuro.
export { percentToCents };
