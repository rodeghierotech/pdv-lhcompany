import { expect, test } from '@playwright/test';
import { adminToken, closeOpenCash, createStockedVariant, login } from './helpers.js';

const BRL = (v: string) =>
  new RegExp(v.replace(/\./g, '\\.').replace(',', ',').replace(/ /g, '\\s'));

test.describe.configure({ mode: 'serial' });

test('caixa → venda à vista → fiado parcial → recebimento posterior → sangria → fechamento com diferença', async ({
  page,
  request,
}) => {
  const token = await adminToken(request);
  await closeOpenCash(request, token);
  const sku = await createStockedVariant(request, token, { priceCents: 5000, stock: 10 });
  const customerName = `Cliente E2E ${Date.now()}`;

  await login(page);

  // Sem caixa: PDV bloqueia a venda e orienta abrir o caixa.
  await expect(page.getByText('Caixa fechado: abra o caixa para registrar vendas.')).toBeVisible();

  // Abertura de caixa com valor inicial.
  await page.goto('/caixa');
  await page.getByLabel('Valor inicial (R$) *').fill('100,00');
  await page.getByRole('button', { name: 'Abrir caixa' }).click();
  await expect(page.getByTestId('expected-cash')).toContainText(BRL('100,00'));

  // Venda 1: 1 un. paga integralmente em dinheiro (R$ 50,00).
  await page.goto('/vender');
  await page.getByLabel('Buscar produto').fill(sku);
  await page.getByLabel('Buscar produto').press('Enter');
  await expect(page.getByTestId('total')).toContainText(BRL('50,00'));
  await page.getByRole('button', { name: 'Dinheiro', exact: true }).click();
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /concluída/ })).toContainText('pago');

  // Venda 2: 2 un. (R$ 100,00), só R$ 40,00 em PIX → parcial; cliente obrigatório.
  await page.getByLabel('Buscar produto').fill(sku);
  await page.getByLabel('Buscar produto').press('Enter');
  await page.getByLabel(`Aumentar ${sku}`).click();
  await page.getByRole('button', { name: 'PIX', exact: true }).click();
  await page.getByLabel('Valor 1').fill('40,00');
  await expect(page.getByRole('button', { name: /Finalizar venda/ })).toBeDisabled();
  await expect(page.getByText('Informe o cliente para fiado/parcial')).toBeVisible();
  await page.getByRole('button', { name: /Novo cliente/ }).click();
  await page.locator('#new-customer-name').fill(customerName);
  await page.getByRole('button', { name: 'Cadastrar' }).click();
  await page.getByLabel('Vencimento (opcional)').fill('2099-12-31');
  await page.getByRole('button', { name: /Finalizar venda/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /concluída/ })).toContainText(
    'a receber R$',
  );

  // Conta-corrente: saldo devedor R$ 60,00.
  await page.goto('/clientes');
  await page.getByLabel('Buscar cliente').fill(customerName);
  await page.getByRole('link', { name: customerName }).click();
  await expect(page.getByTestId('customer-debt')).toContainText(BRL('60,00'));

  // Recebimento parcial em dinheiro (R$ 20,00).
  await page.getByRole('button', { name: 'Receber do saldo' }).click();
  await page.getByLabel('Valor 1').fill('20,00');
  await page.getByRole('button', { name: 'Confirmar recebimento' }).click();
  await expect(page.getByTestId('customer-debt')).toContainText(BRL('40,00'));

  // Não aceita pagamento acima do saldo.
  await page.getByRole('button', { name: 'Receber do saldo' }).click();
  await page.getByLabel('Valor 1').fill('41,00');
  await expect(page.getByRole('button', { name: 'Confirmar recebimento' })).toBeDisabled();
  await expect(page.getByText(/Excede o saldo/)).toBeVisible();
  await page.getByLabel('Valor 1').fill('40,00');
  await page.getByLabel('Forma de pagamento 1').selectOption('pix');
  await page.getByRole('button', { name: 'Confirmar recebimento' }).click();
  await expect(page.getByTestId('customer-debt')).toContainText(BRL('0,00'));
  await expect(page.getByText('Sem dívidas em aberto.')).toBeVisible();

  // Caixa: dinheiro esperado = 100 (abertura) + 50 (venda) + 20 (fiado em dinheiro); PIX não entra.
  await page.goto('/caixa');
  await expect(page.getByTestId('expected-cash')).toContainText(BRL('170,00'));

  // Sangria de R$ 30,00 → R$ 140,00.
  await page.getByRole('button', { name: 'Sangria' }).click();
  await page.getByLabel('Valor *').fill('30,00');
  await page.getByLabel('Descrição *').fill('Depósito no banco');
  await page.getByRole('button', { name: 'Registrar' }).click();
  await expect(page.getByTestId('expected-cash')).toContainText(BRL('140,00'));
  await expect(page.getByRole('cell', { name: 'Sangria' }).first()).toBeVisible();

  // Fechamento com falta de R$ 2,00: exige justificativa.
  await page.getByRole('button', { name: 'Fechar caixa' }).click();
  await page.getByLabel('Valor contado *').fill('138,00');
  await expect(page.getByTestId('close-difference')).toContainText(/Falta de R\$\s2,00/);
  await expect(page.getByRole('button', { name: 'Fechar caixa' }).last()).toBeDisabled();
  await page.getByLabel('Justificativa da diferença *').fill('Troco errado');
  await page.getByRole('button', { name: 'Fechar caixa' }).last().click();

  // Histórico: caixa fechado com diferença registrada.
  await page.goto('/caixa/historico');
  const row = page.locator('tbody tr').first();
  await expect(row).toContainText('Fechado');
  await expect(row).toContainText(BRL('2,00'));
  await row.getByRole('link').click();
  await expect(page.getByTestId('session-difference')).toContainText(BRL('2,00'));
  await expect(page.getByRole('cell', { name: 'Recebimento de fiado' }).first()).toBeVisible();
});
