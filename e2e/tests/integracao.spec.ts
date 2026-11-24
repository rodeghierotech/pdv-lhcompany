import { expect, test } from '@playwright/test';
import { API, adminToken, auth, login } from './helpers.js';

test('admin vê o estado da integração; sem credenciais nada é conectado nem "sincronizado"', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'Integrações' }).click();
  await page.waitForURL('**/integracoes');
  await expect(page.getByRole('heading', { name: 'Integração Nuvemshop' })).toBeVisible();
  await expect(page.getByTestId('connection-status')).toHaveText('Não conectada');
  await expect(page.getByRole('alert')).toContainText('não configurado');
  // sem confirmação externa, não pode aparecer como sincronizado
  await expect(page.getByTestId('stock-sync-state')).toContainText('NÃO confirmado');

  await page.getByRole('tab', { name: /Pendências/ }).click();
  await expect(page.getByText('Nenhuma pendência aberta.')).toBeVisible();
  await page.getByRole('tab', { name: 'Produtos' }).click();
  await expect(page.getByRole('combobox', { name: 'Filtro' })).toBeVisible();
  await page.getByRole('tab', { name: 'Fila de estoque' }).click();
  await expect(page.getByRole('heading', { name: 'Fila de atualização de estoque' })).toBeVisible();
});

test('vendedor não acessa a integração', async ({ page, request }) => {
  const token = await adminToken(request);
  const email = `vendedor.int.${Date.now()}@e2e.dev`;
  const password = 'senha-vendedor-123';
  const created = await request.post(`${API}/users`, {
    headers: auth(token),
    data: { name: 'Vendedor Int', email, password, role: 'vendedor' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  await page.goto('/login');
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole('button', { name: /entrar/i }).click();
  await page.waitForURL('**/vender');
  await expect(page.getByRole('link', { name: 'Integrações' })).toHaveCount(0);
  await page.goto('/integracoes');
  await page.waitForURL('**/vender');
});
