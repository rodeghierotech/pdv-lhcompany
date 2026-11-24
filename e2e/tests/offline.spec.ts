import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  API,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminToken,
  auth,
  brlPattern,
  closeOpenCash,
  createStockedVariantFull,
} from './helpers.js';

// Build de produção (Service Worker ativo) servido em outra porta.
const PREVIEW = process.env.E2E_PREVIEW_URL ?? 'http://localhost:4173';
test.use({ baseURL: PREVIEW });

async function loginPreview(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/e-?mail/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/senha/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /entrar/i }).click();
  await page.waitForURL('**/vender');
}

const stockOf = async (request: APIRequestContext, token: string, id: string) => {
  const v = await request.get(`${API}/sync/catalog`, { headers: auth(token) });
  const snap = (await v.json()) as { variants: { id: string; stock: number }[] };
  return snap.variants.find((x) => x.id === id)?.stock;
};

test('vende offline, reinicia o navegador com venda pendente e sincroniza ao reconectar', async ({
  page,
  context,
  request,
}) => {
  const token = await adminToken(request);
  await closeOpenCash(request, token);
  const open = await request.post(`${API}/cash/open`, {
    headers: auth(token),
    data: { idempotencyKey: crypto.randomUUID(), openingCents: 10_000 },
  });
  expect(open.ok(), await open.text()).toBeTruthy();
  const { sku, variantId } = await createStockedVariantFull(request, token, {
    priceCents: 4500,
    stock: 5,
  });

  await loginPreview(page);

  // Online: o aparelho recebe a autorização offline e o catálogo.
  await page.goto('/sincronizacao');
  await expect(page.getByText(/válida até/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('não baixado')).toHaveCount(0, { timeout: 20_000 });

  // Service Worker controlando a página (necessário para recarregar sem internet).
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);

  // ---- Sem conexão ----
  await context.setOffline(true);
  await page.reload(); // reinício da aplicação sem rede: sessão retomada pela autorização offline
  await expect(page.getByText(/Sem conexão/).first()).toBeVisible({ timeout: 20_000 });
  await page.goto('/vender');
  await expect(page.getByRole('heading', { name: /Carrinho/ })).toBeVisible();

  await page.getByLabel('Buscar produto').fill(sku);
  await page.getByLabel('Buscar produto').press('Enter'); // catálogo local
  await expect(page.getByTestId('total')).toContainText(brlPattern(4500));
  await page.getByRole('button', { name: 'Dinheiro', exact: true }).click();
  await page.getByRole('button', { name: /Finalizar venda/ }).click();

  const banner = page.getByTestId('offline-sale-banner');
  await expect(banner).toContainText('Venda salva neste aparelho');
  await expect(banner).toContainText('NÃO confirmada');
  await expect(banner).not.toContainText('Confirmada');
  await expect(page.getByLabel('Sincronização pendente')).toContainText('1 pendente');

  // Fiado/parcial exigem o servidor: bloqueado offline.
  await page.getByLabel('Buscar produto').fill(sku);
  await page.getByLabel('Buscar produto').press('Enter');
  await page.getByRole('button', { name: 'PIX', exact: true }).click();
  await page.getByLabel('Valor 1').fill('10,00');
  await expect(page.getByRole('button', { name: /Finalizar venda/ })).toBeDisabled();
  await expect(page.getByText(/apenas vendas pagas integralmente/)).toBeVisible();

  // Reinício do navegador com a venda pendente: continua na fila, ainda não confirmada.
  await page.reload();
  await page.goto('/sincronizacao');
  await expect(page.getByTestId('pending-count')).toHaveText('1');
  await expect(page.getByTestId('local-op')).toContainText('Salva no aparelho');

  // Servidor ainda sem a venda (estoque intacto).
  expect(await stockOf(request, token, variantId)).toBe(5);

  // Logout com venda pendente e sem rede é bloqueado.
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByText(/não sincronizada/)).toBeVisible();

  // ---- Reconecta ----
  await context.setOffline(false);
  await expect(page.getByTestId('local-op')).toContainText('Confirmada', { timeout: 40_000 });
  await expect(page.getByTestId('pending-count')).toHaveText('0');
  await expect(page.getByTestId('local-op')).toContainText(/venda #\d+/);
  expect(await stockOf(request, token, variantId)).toBe(4);

  await closeOpenCash(request, token);
});
