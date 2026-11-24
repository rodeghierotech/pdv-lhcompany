import { expect, test } from '@playwright/test';
import {
  API,
  adminToken,
  auth,
  brlPattern,
  closeOpenCash,
  createStockedVariantFull,
  login,
} from './helpers.js';

interface Summary {
  sales: { netCents: number; grossCents: number; validCount: number };
  receipts: { netCents: number };
  expenses: { netCents: number };
  openDebts: { totalCents: number };
}

test('painel: faturamento × recebimento, despesas, exportação CSV e acesso restrito', async ({
  page,
  request,
}) => {
  const token = await adminToken(request);
  await closeOpenCash(request, token);
  const { variantId } = await createStockedVariantFull(request, token, {
    priceCents: 8000,
    stock: 5,
  });
  const summaryOf = async (): Promise<Summary> =>
    (
      (await (await request.get(`${API}/reports/summary`, { headers: auth(token) })).json()) as {
        summary: Summary;
      }
    ).summary;

  const before = await summaryOf();

  // Caixa aberto + venda de R$ 80,00 com só R$ 30,00 recebidos em PIX (fiado de R$ 50,00) + despesa de R$ 12,00.
  const open = await request.post(`${API}/cash/open`, {
    headers: auth(token),
    data: { idempotencyKey: crypto.randomUUID(), openingCents: 5000 },
  });
  expect(open.ok(), await open.text()).toBeTruthy();
  const customer = await request.post(`${API}/customers`, {
    headers: auth(token),
    data: { name: `Cliente Painel ${Date.now()}` },
  });
  const customerId = ((await customer.json()) as { customer: { id: string } }).customer.id;
  const sale = await request.post(`${API}/sales`, {
    headers: auth(token),
    data: {
      idempotencyKey: crypto.randomUUID(),
      customerId,
      items: [{ variantId, quantity: 1, unitPriceCents: 8000, discountCents: 0 }],
      payments: [{ method: 'pix', amountCents: 3000 }],
    },
  });
  expect(sale.ok(), await sale.text()).toBeTruthy();
  const expense = await request.post(`${API}/cash/movements`, {
    headers: auth(token),
    data: {
      idempotencyKey: crypto.randomUUID(),
      kind: 'despesa',
      amountCents: 1200,
      description: 'Material de limpeza',
      category: 'Limpeza E2E',
    },
  });
  expect(expense.ok(), await expense.text()).toBeTruthy();

  await login(page);
  await page.getByRole('link', { name: 'Painel' }).click();
  await expect(page.getByTestId('kpi-net-sales')).toContainText(
    brlPattern(before.sales.netCents + 8000),
  );
  // Recebido é menor que o faturamento: a diferença (R$ 50,00) está em aberto no fiado.
  await expect(page.getByTestId('kpi-received')).toContainText(
    brlPattern(before.receipts.netCents + 3000),
  );
  await expect(page.getByTestId('kpi-open-debts')).toContainText(
    brlPattern(before.openDebts.totalCents + 5000),
  );
  await expect(page.getByTestId('kpi-expenses')).toContainText(
    brlPattern(before.expenses.netCents + 1200),
  );
  await expect(page.getByText('Limpeza E2E')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Faturamento e recebimento por dia' })).toBeVisible();
  await expect(page.getByText('Movimentações recentes')).toBeVisible();

  // Período inválido não dispara consulta e avisa.
  await page.getByLabel('Até').fill('2000-01-01');
  await expect(page.getByRole('alert').filter({ hasText: 'Período inválido' })).toBeVisible();
  await page.getByRole('button', { name: 'Hoje' }).click();
  await expect(page.getByTestId('kpi-net-sales')).toBeVisible();

  // Exportação CSV de vendas: arquivo baixado contém a venda criada (e o nome do cliente).
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Vendas (CSV)' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^sales-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv).toContain(
    'numero;data;cliente;vendedor;status;pagamento;total;desconto;devolvido;recebido_liquido;saldo',
  );
  expect(csv).toContain(';parcial;80,00;0,00;0,00;30,00;50,00');

  await closeOpenCash(request, token);
});

test('painel é restrito: vendedor não vê o link e é redirecionado', async ({ page, request }) => {
  const token = await adminToken(request);
  const email = `vendedor.painel.${Date.now()}@e2e.dev`;
  const password = 'senha-vendedor-123';
  const created = await request.post(`${API}/users`, {
    headers: auth(token),
    data: { name: 'Vendedor Painel', email, password, role: 'vendedor' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto('/login');
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole('button', { name: /entrar/i }).click();
  await page.waitForURL('**/vender');
  await expect(page.getByRole('link', { name: 'Painel' })).toHaveCount(0);
  await page.goto('/painel');
  await page.waitForURL('**/vender');
});
