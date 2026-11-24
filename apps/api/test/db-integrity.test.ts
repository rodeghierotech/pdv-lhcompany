import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import type { TestCtx } from './helpers.js';

let ctx: TestCtx;
let variantId: string;

beforeAll(async () => {
  ctx = await setup();
  const p = await ctx.pool.query<{ id: string }>(
    "insert into products (name) values ('Camiseta') returning id",
  );
  const v = await ctx.pool.query<{ id: string }>(
    `insert into product_variants (product_id, sku, price_cents) values ($1, 'CAM-P', 5000) returning id`,
    [p.rows[0]!.id],
  );
  variantId = v.rows[0]!.id;
});
afterAll(() => ctx.close());

const stock = async () =>
  (
    await ctx.pool.query<{ quantity: number }>(
      'select quantity from stock_levels where variant_id = $1',
      [variantId],
    )
  ).rows[0]!.quantity;

describe('integridade do estoque no banco', () => {
  it('cria saldo zerado ao criar a variante', async () => {
    expect(await stock()).toBe(0);
  });

  it('deriva o saldo das movimentações', async () => {
    await ctx.pool.query(
      `insert into stock_movements (variant_id, type, quantity_delta) values ($1, 'entrada', 10)`,
      [variantId],
    );
    await ctx.pool.query(
      `insert into stock_movements (variant_id, type, quantity_delta) values ($1, 'ajuste', -3)`,
      [variantId],
    );
    expect(await stock()).toBe(7);
  });

  it('bloqueia alteração direta do saldo', async () => {
    await expect(
      ctx.pool.query('update stock_levels set quantity = 999 where variant_id = $1', [variantId]),
    ).rejects.toThrow(/derivado/);
    await expect(
      ctx.pool.query('delete from stock_levels where variant_id = $1', [variantId]),
    ).rejects.toThrow(/derivado/);
    expect(await stock()).toBe(7);
  });

  it('torna movimentações imutáveis', async () => {
    await expect(ctx.pool.query('update stock_movements set quantity_delta = 1')).rejects.toThrow(
      /imutável/,
    );
    await expect(ctx.pool.query('delete from stock_movements')).rejects.toThrow(/imutável/);
  });

  it('torna a auditoria e os lotes imutáveis', async () => {
    await ctx.pool.query(`insert into audit_log (action, entity) values ('x', 'y')`);
    await expect(ctx.pool.query('delete from audit_log')).rejects.toThrow(/imutável/);
    const batch = await ctx.pool.query<{ id: string }>(
      `insert into stock_batches (variant_id, quantity) values ($1, 1) returning id`,
      [variantId],
    );
    await expect(
      ctx.pool.query('update stock_batches set quantity = 2 where id = $1', [batch.rows[0]!.id]),
    ).rejects.toThrow(/imutável/);
  });

  it('rejeita sinal incoerente com o tipo e delta zero', async () => {
    await expect(
      ctx.pool.query(
        `insert into stock_movements (variant_id, type, quantity_delta) values ($1, 'entrada', -2)`,
        [variantId],
      ),
    ).rejects.toThrow(/stock_movements_sign_ck/);
    await expect(
      ctx.pool.query(
        `insert into stock_movements (variant_id, type, quantity_delta) values ($1, 'ajuste', 0)`,
        [variantId],
      ),
    ).rejects.toThrow(/quantity_delta_check|check/);
  });

  it('exige que o estorno anule exatamente o movimento original, uma única vez', async () => {
    const original = (
      await ctx.pool.query<{ id: string }>(
        `insert into stock_movements (variant_id, type, quantity_delta) values ($1, 'ajuste', 5) returning id`,
        [variantId],
      )
    ).rows[0]!.id;

    // delta errado
    await expect(
      ctx.pool.query(
        `insert into stock_movements (variant_id, type, quantity_delta, reverses_movement_id)
         values ($1, 'estorno', -4, $2)`,
        [variantId, original],
      ),
    ).rejects.toThrow(/estorno inválido/);

    await ctx.pool.query(
      `insert into stock_movements (variant_id, type, quantity_delta, reverses_movement_id)
       values ($1, 'estorno', -5, $2)`,
      [variantId, original],
    );
    expect(await stock()).toBe(7);

    // segundo estorno do mesmo movimento
    await expect(
      ctx.pool.query(
        `insert into stock_movements (variant_id, type, quantity_delta, reverses_movement_id)
         values ($1, 'estorno', -5, $2)`,
        [variantId, original],
      ),
    ).rejects.toThrow(/duplicate|unique/);
  });

  it('desfaz tudo quando a transação falha no meio', async () => {
    const before = await stock();
    const client = await ctx.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into stock_movements (variant_id, type, quantity_delta) values ($1, 'entrada', 100)`,
        [variantId],
      );
      await expect(
        client.query(
          `insert into stock_movements (variant_id, type, quantity_delta) values ($1, 'entrada', -5)`,
          [variantId],
        ),
      ).rejects.toThrow();
      await client.query('rollback');
    } finally {
      client.release();
    }
    expect(await stock()).toBe(before);
  });

  it('migrations são idempotentes ao reaplicar', async () => {
    const { runMigrations } = await import('../src/db/migrate.js');
    const result = await runMigrations(ctx.pool);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('001_init.sql');
  });
});
