import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  CreateProductCommandSchema,
  type CreateProductCommand,
} from "@lh-company/contracts";

import { runMigrations } from "../../infrastructure/migration-runner.js";
import { getTestDatabasePool, resetProductInventoryTables } from "../../test/database-test-support.js";
import { OperationPayloadConflictError, ProductConflictError } from "./product-errors.js";
import { createProductRepository } from "./product-repository.js";
import { createProductService } from "./product-service.js";

const database = getTestDatabasePool();
const repository = createProductRepository();
const service = createProductService({ database, repository });

before(async () => {
  await runMigrations(database);
});
beforeEach(async () => {
  await resetProductInventoryTables(database);
});
after(async () => {
  try {
    await resetProductInventoryTables(database);
  } finally {
    await database.end();
  }
});

function command(): CreateProductCommand {
  return CreateProductCommandSchema.parse({
    operationId: randomUUID(),
    product: {
      name: "Camiseta básica",
      description: "Algodão",
      category: "Camisetas",
      active: true,
      variants: [
        {
          sku: "CAM-P-AZUL",
          barcode: "7890000000011",
          attributes: [{ name: "Tamanho", value: "P" }, { name: "Cor", value: "Azul" }],
          salePriceInCents: 5990,
          costInCents: 2500,
          tracksInventory: true,
          active: true,
        },
      ],
    },
  });
}

async function counts() {
  const result = await database.query<{
    products: number;
    variants: number;
    balances: number;
    movements: number;
    lots: number;
  }>(`
    SELECT (SELECT COUNT(*)::INT FROM product) AS products,
           (SELECT COUNT(*)::INT FROM product_variant) AS variants,
           (SELECT COUNT(*)::INT FROM inventory_balance) AS balances,
           (SELECT COUNT(*)::INT FROM inventory_movement) AS movements,
           (SELECT COUNT(*)::INT FROM stock_lot) AS lots
  `);
  return result.rows[0];
}

// Both real transactions finish their initial lookup before either inserts.
function concurrentService() {
  let initialReads = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
  return createProductService({
    database,
    repository: {
      ...repository,
      async findByOperationId(client, operationId) {
        const result = await repository.findByOperationId(client, operationId);
        initialReads += 1;
        if (initialReads === 2) {
          releaseReads();
        }
        if (initialReads <= 2) {
          await bothRead;
        }
        return result;
      },
    },
  });
}

test("creates_product_variants_and_zero_balances_in_one_transaction", async () => {
  const input = command();
  const first = input.product.variants[0]!;
  input.product.variants.push(
    { ...first, sku: "CAM-M-AZUL", barcode: null, minimumStockQuantity: 7, active: false },
    { ...first, sku: "SERVICO", barcode: null, tracksInventory: false },
  );
  const product = await service.create(input);

  assert.equal(product.name, "Camiseta básica");
  assert.equal(product.description, "Algodão");
  assert.equal(product.category, "Camisetas");
  assert.equal(product.active, true);
  assert.match(product.id, /^[\da-f-]{36}$/);
  assert.equal(product.variants.length, 3);
  for (const variant of product.variants) {
    assert.match(variant.id, /^[\da-f-]{36}$/);
    assert.equal(variant.productId, product.id);
    assert.deepEqual(variant, {
      ...input.product.variants.find((candidate) => candidate.sku === variant.sku),
      id: variant.id,
      productId: product.id,
    });
  }
  assert.equal(new Set([product.id, ...product.variants.map((variant) => variant.id)]).size, 4);
  assert.deepEqual(await counts(), { products: 1, variants: 3, balances: 2, movements: 0, lots: 0 });
  const balances = await database.query<{ sku: string; quantity: number }>(`
    SELECT variant.sku, balance.quantity FROM inventory_balance AS balance
    JOIN product_variant AS variant ON variant.id = balance.variant_id ORDER BY variant.sku
  `);
  assert.deepEqual(balances.rows, [{ sku: "CAM-M-AZUL", quantity: 0 }, { sku: "CAM-P-AZUL", quantity: 0 }]);
  const operation = await database.query<{ operation_id: string; operation_fingerprint: string }>(
    "SELECT operation_id, operation_fingerprint FROM product WHERE id = $1", [product.id],
  );
  assert.equal(operation.rows[0]?.operation_id, input.operationId);
  assert.match(operation.rows[0]?.operation_fingerprint ?? "", /^[\da-f]{64}$/);
});

test("rolls_back_product_when_variant_insert_fails", async () => {
  const input = command();
  input.product.variants.push({ ...input.product.variants[0]! });
  await assert.rejects(service.create(input), ProductConflictError);
  assert.deepEqual(await counts(), { products: 0, variants: 0, balances: 0, movements: 0, lots: 0 });
});

test("returns_original_product_for_same_operation_and_payload", async () => {
  const input = command();
  const original = await service.create(input);
  const replay = await service.create(input);
  assert.deepEqual(replay, original);
  assert.deepEqual(await counts(), { products: 1, variants: 1, balances: 1, movements: 0, lots: 0 });
});

test("normalizes_command_before_fingerprinting_and_applies_default_stock_limit", async () => {
  const input = command();
  const original = await service.create(input);
  const variant = input.product.variants[0]!;
  const withoutDefault = { ...variant };
  Reflect.deleteProperty(withoutDefault, "minimumStockQuantity");
  const replay = await service.create({
    product: {
      ...input.product,
      name: "  Camiseta básica  ",
      variants: [{ ...withoutDefault, sku: "  CAM-P-AZUL  " }],
    },
    operationId: input.operationId,
  } as CreateProductCommand);
  assert.equal(original.variants[0]?.minimumStockQuantity, 3);
  assert.deepEqual(replay, original);
});

test("rejects_same_operation_with_different_payload", async () => {
  const input = command();
  const original = await service.create(input);
  await assert.rejects(
    service.create({ ...input, product: { ...input.product, name: "Outro produto" } }),
    (error) => error instanceof OperationPayloadConflictError && error.code === "OPERATION_PAYLOAD_CONFLICT",
  );
  assert.deepEqual(await service.create(input), original);
  assert.deepEqual(await counts(), { products: 1, variants: 1, balances: 1, movements: 0, lots: 0 });
});

test("fingerprints_all_client_product_and_variant_fields", async () => {
  const input = command();
  await service.create(input);
  const productChanges = [
    { description: null }, { category: null }, { active: false },
  ];
  for (const change of productChanges) {
    await assert.rejects(service.create({ ...input, product: { ...input.product, ...change } }), OperationPayloadConflictError);
  }
  const variantChanges = [
    { sku: "OTHER" }, { barcode: null }, { attributes: [] },
    { salePriceInCents: 6000 }, { costInCents: 3000 },
    { tracksInventory: false }, { minimumStockQuantity: 4 }, { active: false },
  ];
  for (const change of variantChanges) {
    await assert.rejects(service.create({
      ...input,
      product: { ...input.product, variants: [{ ...input.product.variants[0]!, ...change }] },
    }), OperationPayloadConflictError);
  }
});

test("maps_duplicate_sku_and_barcode_to_product_conflict", async () => {
  await service.create(command());
  for (const variant of [
    { ...command().product.variants[0]!, barcode: null },
    { ...command().product.variants[0]!, sku: "DIFFERENT-SKU" },
  ]) {
    const input = command();
    input.product.variants = [variant];
    await assert.rejects(service.create(input), (error) => error instanceof ProductConflictError && error.code === "PRODUCT_CONFLICT");
  }
  assert.deepEqual(await counts(), { products: 1, variants: 1, balances: 1, movements: 0, lots: 0 });
});

test("concurrent_calls_with_same_operation_leave_one_product", async () => {
  const input = command();
  const racing = concurrentService();
  const [first, second] = await Promise.all([racing.create(input), racing.create(input)]);
  assert.deepEqual(first, second);
  assert.deepEqual(await counts(), { products: 1, variants: 1, balances: 1, movements: 0, lots: 0 });
});

test("concurrent_calls_with_conflicting_payload_reject_the_losing_operation", async () => {
  const input = command();
  const racing = concurrentService();
  const results = await Promise.allSettled([
    racing.create(input),
    racing.create({ ...input, product: { ...input.product, name: "Produto incompatível" } }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection?.status === "rejected");
  assert.ok(rejection.reason instanceof OperationPayloadConflictError);
  assert.deepEqual(await counts(), { products: 1, variants: 1, balances: 1, movements: 0, lots: 0 });
});

test("preserves_unknown_unique_constraint_errors", async () => {
  const original = await service.create(command());
  const colliding = createProductService({ database, repository, idFactory: () => original.id });
  const input = command();
  input.product.variants[0]!.sku = "NEW-SKU";
  input.product.variants[0]!.barcode = null;
  await assert.rejects(colliding.create(input), { code: "23505", constraint: "product_pkey" });
  assert.deepEqual(await counts(), { products: 1, variants: 1, balances: 1, movements: 0, lots: 0 });
});
