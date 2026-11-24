import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

export const API = `http://localhost:${process.env.E2E_API_PORT ?? '3333'}`;
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@lh.dev';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'senha-dev-12345';

export async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok(), 'login do admin (defina E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD)').toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Fecha o caixa aberto do admin (se houver) para o teste começar de um estado conhecido. */
export async function closeOpenCash(request: APIRequestContext, token: string): Promise<void> {
  const cur = await request.get(`${API}/cash/current`, { headers: auth(token) });
  const body = (await cur.json()) as {
    session: { id: string } | null;
    report: { expectedCashCents: number } | null;
  };
  if (!body.session || !body.report) return;
  const res = await request.post(`${API}/cash/sessions/${body.session.id}/close`, {
    headers: auth(token),
    data: { idempotencyKey: crypto.randomUUID(), countedCents: body.report.expectedCashCents },
  });
  expect(res.ok()).toBeTruthy();
}

/** Cria produto com uma variante e estoque; devolve o SKU. */
export async function createStockedVariant(
  request: APIRequestContext,
  token: string,
  opts: { priceCents: number; stock: number },
): Promise<string> {
  return (await createStockedVariantFull(request, token, opts)).sku;
}

export async function createStockedVariantFull(
  request: APIRequestContext,
  token: string,
  opts: { priceCents: number; stock: number },
): Promise<{ sku: string; variantId: string }> {
  const sku = `E2E-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
  const created = await request.post(`${API}/products`, {
    headers: auth(token),
    data: {
      idempotencyKey: crypto.randomUUID(),
      name: `Produto ${sku}`,
      variants: [{ sku, size: 'U', color: 'Azul', priceCents: opts.priceCents, minStock: 0 }],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const product = (
    (await created.json()) as { product: { variants: { id: string; sku: string }[] } }
  ).product;
  const variant = product.variants.find((v) => v.sku === sku);
  expect(variant).toBeTruthy();
  const entry = await request.post(`${API}/stock/entries`, {
    headers: auth(token),
    data: {
      idempotencyKey: crypto.randomUUID(),
      variantId: variant!.id,
      quantity: opts.stock,
      unitCostCents: 1000,
    },
  });
  expect(entry.ok(), await entry.text()).toBeTruthy();
  return { sku, variantId: variant!.id };
}

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/e-?mail/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/senha/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /entrar/i }).click();
  await page.waitForURL('**/vender');
}

/** Texto BRL como o navegador exibe, tolerante a espaço não separável. */
export function brlPattern(cents: number): RegExp {
  const text = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    cents / 100,
  );
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s\u00a0]/g, '\\s'));
}
