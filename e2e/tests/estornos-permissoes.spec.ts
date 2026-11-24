import { expect, test } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API,
  adminToken,
  auth,
  closeOpenCash,
  createStockedVariant,
} from './helpers.js';
import type { Page } from '@playwright/test';

const BRL = (v: string) => new RegExp(v.replace(/ /g, '\\s'));

async function loginAs(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole('button', { name: /entrar/i }).click();
  await page.waitForURL('**/vender');
}

test('devolução e cancelamento movimentam o caixa por compensação; vendedor não faz sangria', async ({
  page,
  request,
}) => {
  const token = await adminToken(request);
  await closeOpenCash(request, token);
  const sku = await createStockedVariant(request, token, { priceCents: 3000, stock: 10 });

  const vendedorEmail = `vendedor.${Date.now()}@e2e.dev`;
  const vendedorPassword = 'senha-vendedor-123';
  const created = await request.post(`${API}/users`, {
    headers: auth(token),
    data: {
      name: 'Vendedor E2E',
      email: vendedorEmail,
      password: vendedorPassword,
      role: 'vendedor',
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/caixa');
  await page.getByLabel('Valor inicial (R$) *').fill('0');
  await page.getByRole('button', { name: 'Abrir caixa' }).click();
  await expect(page.getByTestId('expected-cash')).toContainText(BRL('0,00'));

  // Venda de 3 un. (R$ 90,00) em dinheiro.
  await page.goto('/vender');
  await page.getByLabel('Buscar produto').fill(sku);
  await page.getByLabel('Buscar produto').press('Enter');
  await page.getByLabel(`Aumentar ${sku}`).click();
  await page.getByLabel(`Aumentar ${sku}`).click();
  await page.getByRole('button', { name: 'Dinheiro', exact: true }).click();
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  await page.getByRole('link', { name: 'Ver venda' }).click();
  await expect(page.getByText('Pago').first()).toBeVisible();

  // Devolução de 1 un.: reembolso de R$ 30,00 em dinheiro sai do caixa.
  await page.getByRole('button', { name: 'Devolver itens' }).click();
  await page.getByLabel(`Devolver ${sku}`).fill('1');
  await expect(page.getByText('Reembolso ao cliente')).toBeVisible();
  await page.getByLabel('Motivo *').fill('Tamanho errado');
  await page.getByRole('button', { name: 'Confirmar devolução' }).click();
  await expect(page.getByText('Estorno · Dinheiro')).toBeVisible();
  // Com devolução registrada o cancelamento total deixa de ser permitido.
  await expect(page.getByRole('button', { name: 'Cancelar venda' })).toHaveCount(0);

  await page.goto('/caixa');
  await expect(page.getByTestId('expected-cash')).toContainText(BRL('60,00'));
  await expect(page.getByRole('cell', { name: 'Estorno de pagamento' }).first()).toBeVisible();

  // Venda 2 e cancelamento total: caixa volta ao valor anterior.
  await page.goto('/vender');
  await page.getByLabel('Buscar produto').fill(sku);
  await page.getByLabel('Buscar produto').press('Enter');
  await page.getByRole('button', { name: 'PIX', exact: true }).click();
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  await page.getByRole('link', { name: 'Ver venda' }).click();
  await page.getByRole('button', { name: 'Cancelar venda' }).click();
  await page.getByLabel('Motivo *').fill('Cliente desistiu');
  await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
  await expect(page.getByText('Cancelada').first()).toBeVisible();
  await page.goto('/caixa');
  await expect(page.getByTestId('expected-cash')).toContainText(BRL('60,00')); // PIX não mexe na gaveta

  // Vendedor: abre o próprio caixa, mas não vê sangria/suprimento/despesa nem configurações.
  await page.getByRole('button', { name: 'Sair' }).click();
  await loginAs(page, vendedorEmail, vendedorPassword);
  await expect(page.getByRole('link', { name: 'Configurações' })).toHaveCount(0);
  await page.goto('/caixa');
  await page.getByLabel('Valor inicial (R$) *').fill('10,00');
  await page.getByRole('button', { name: 'Abrir caixa' }).click();
  await expect(page.getByTestId('expected-cash')).toContainText(BRL('10,00'));
  await expect(page.getByRole('button', { name: 'Sangria' })).toHaveCount(0);

  // Limpeza: fecha o caixa do vendedor via API para não deixar sessões abertas.
  const login = await request.post(`${API}/auth/login`, {
    data: { email: vendedorEmail, password: vendedorPassword },
  });
  const vToken = ((await login.json()) as { token: string }).token;
  await closeOpenCash(request, vToken);
  await closeOpenCash(request, token);
});
