import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { Writable } from "node:stream";

import {
  CreateProductCommandSchema,
  ProductCatalogItemSchema,
  ProductSchema,
  type CreateProductCommand,
  type ProductCatalogItem,
} from "@lh-company/contracts";
import Fastify from "fastify";

import { createApp } from "../../app.js";
import { runMigrations } from "../../infrastructure/migration-runner.js";
import { getTestDatabasePool, resetProductInventoryTables } from "../../test/database-test-support.js";
import { createProductRepository } from "./product-repository.js";
import { registerProductRoutes } from "./product-routes.js";
import { createProductService } from "./product-service.js";

const database = getTestDatabasePool();
const service = createProductService({ database, repository: createProductRepository() });
const app = createApp({ database });

before(async () => {
  await runMigrations(database);
  await app.ready();
});
beforeEach(async () => {
  await resetProductInventoryTables(database);
});
after(async () => {
  await app.close();
  try {
    await resetProductInventoryTables(database);
  } finally {
    await database.end();
  }
});

function command(name = "Camiseta básica", sku = "CAM-P-AZUL"): CreateProductCommand {
  return CreateProductCommandSchema.parse({
    operationId: randomUUID(),
    product: {
      name,
      description: "Algodão",
      category: "Camisetas",
      active: true,
      variants: [{
        sku,
        barcode: null,
        attributes: [{ name: "Tamanho", value: "P" }],
        salePriceInCents: 5990,
        costInCents: 2500,
        tracksInventory: true,
        active: true,
      }],
    },
  });
}

async function catalog(query: Record<string, string> = {}): Promise<ProductCatalogItem[]> {
  const response = await app.inject({ method: "GET", url: "/products", query });
  assert.equal(response.statusCode, 200, response.body);
  return ProductCatalogItemSchema.array().parse(response.json());
}

test("lists_one_catalog_row_per_variant_with_zero_for_missing_balances", async () => {
  const input = command();
  input.product.variants.push({
    ...input.product.variants[0]!, sku: "SERVICO", tracksInventory: false,
  });
  const product = await service.create(input);
  // Simulate a tracked variant that has no materialized balance yet.
  await database.query("DELETE FROM inventory_balance WHERE variant_id = $1", [product.variants[0]!.id]);

  const rows = await catalog();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.sku, row.quantity, row.tracksInventory]), [
    ["CAM-P-AZUL", 0, true], ["SERVICO", 0, false],
  ]);
  assert.deepEqual(rows[0], {
    productId: product.id,
    productName: "Camiseta básica",
    productActive: true,
    variantId: product.variants[0]!.id,
    sku: "CAM-P-AZUL",
    barcode: null,
    attributes: [{ name: "Tamanho", value: "P" }],
    salePriceInCents: 5990,
    costInCents: 2500,
    quantity: 0,
    minimumStockQuantity: 3,
    tracksInventory: true,
    variantActive: true,
  });
  assert.deepEqual((await catalog({ lowStockOnly: "true" })).map((row) => row.sku), ["CAM-P-AZUL"]);
});

test("search_trims_and_matches_name_sku_or_barcode_without_case_sensitivity", async () => {
  const input = command();
  input.product.variants[0]!.barcode = "EAN-AbC-789";
  await service.create(input);
  await service.create(command("Calça", "OTHER-SKU"));

  for (const search of ["  CAMISETA  ", "  cam-p  ", "  abc-789  "]) {
    assert.deepEqual((await catalog({ search })).map((row) => row.sku), ["CAM-P-AZUL"]);
  }
  assert.deepEqual(await catalog({ search: "inexistente" }), []);
});

test("search_treats_sql_wildcards_and_escape_characters_as_literal_text", async () => {
  await service.create(command("Desconto 10%", "PERCENT"));
  await service.create(command("Desconto 100", "PLAIN"));
  await service.create(command("Outro", "CODE_ONE"));
  await service.create(command("Outro", "CODEXONE"));
  await service.create(command("Outro!", "BANG"));

  assert.deepEqual((await catalog({ search: "%" })).map((row) => row.sku), ["PERCENT"]);
  assert.deepEqual((await catalog({ search: "_" })).map((row) => row.sku), ["CODE_ONE"]);
  assert.deepEqual((await catalog({ search: "!" })).map((row) => row.sku), ["BANG"]);
  assert.deepEqual(await catalog({ search: "' OR TRUE --" }), []);
});

test("low_stock_uses_each_tracked_variant_threshold_including_zero_and_negative_stock", async () => {
  const input = command();
  const variant = input.product.variants[0]!;
  input.product.variants = [
    { ...variant, sku: "ABOVE", minimumStockQuantity: 2 },
    { ...variant, sku: "EQUAL", minimumStockQuantity: 7 },
    { ...variant, sku: "NEGATIVE", minimumStockQuantity: 0 },
    { ...variant, sku: "UNTRACKED", tracksInventory: false, minimumStockQuantity: 99 },
    { ...variant, sku: "ZERO", minimumStockQuantity: 0 },
  ];
  await service.create(input);
  await database.query(`
    UPDATE inventory_balance SET quantity = CASE variant.sku
      WHEN 'ABOVE' THEN 3 WHEN 'EQUAL' THEN 7 WHEN 'NEGATIVE' THEN -1 ELSE 0 END
    FROM product_variant AS variant WHERE variant.id = inventory_balance.variant_id
  `);

  assert.deepEqual((await catalog({ lowStockOnly: "true" })).map((row) => row.sku), ["EQUAL", "NEGATIVE", "ZERO"]);
  assert.equal((await catalog({ lowStockOnly: "false" })).length, 5);
});

test("status_filters_combine_product_and_variant_activity", async () => {
  for (const [sku, productActive, variantActive] of [
    ["AA", true, true], ["AI", true, false], ["IA", false, true], ["II", false, false],
  ] as const) {
    const input = command("Produto", sku);
    input.product.active = productActive;
    input.product.variants[0]!.active = variantActive;
    await service.create(input);
  }

  assert.deepEqual((await catalog()).map((row) => row.sku), ["AA"]);
  assert.deepEqual((await catalog({ status: "active" })).map((row) => row.sku), ["AA"]);
  assert.deepEqual((await catalog({ status: "inactive" })).map((row) => row.sku), ["AI", "IA", "II"]);
  assert.deepEqual((await catalog({ status: "all" })).map((row) => row.sku), ["AA", "AI", "IA", "II"]);
});

test("catalog_caps_limit_at_100_and_orders_stably_by_product_name_then_sku", async () => {
  // Insert in reverse order so insertion order cannot satisfy the catalog order.
  for (let index = 100; index >= 0; index -= 1) {
    await service.create(command(index === 100 ? "A primeiro" : "B produto", `SKU-${String(index).padStart(3, "0")}`));
  }

  assert.equal((await catalog()).length, 50);
  const first = await catalog({ limit: "1000" });
  assert.equal(first.length, 100);
  assert.deepEqual(first.slice(0, 3).map((row) => row.sku), ["SKU-100", "SKU-000", "SKU-001"]);
  assert.equal(first.at(-1)?.sku, "SKU-098");
  assert.deepEqual(await catalog({ limit: "1000" }), first);
  assert.deepEqual((await catalog({ limit: "2" })).map((row) => row.sku), ["SKU-100", "SKU-000"]);
});

test("post_creates_and_replays_the_complete_product_aggregate_with_201", async () => {
  const input = command();
  const first = await app.inject({ method: "POST", url: "/products", payload: input });
  assert.equal(first.statusCode, 201, first.body);
  const product = ProductSchema.parse(first.json());
  assert.equal(product.name, "Camiseta básica");
  assert.equal(product.variants[0]?.productId, product.id);
  assert.equal(product.variants[0]?.sku, "CAM-P-AZUL");
  const replay = await app.inject({ method: "POST", url: "/products", payload: input });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json(), product);
});

test("invalid_body_or_query_returns_safe_400_without_writing_products", async () => {
  const invalid = command();
  invalid.product.variants[0]!.salePriceInCents = -1;
  for (const payload of [{}, invalid, { ...command(), operationId: "invalid" }]) {
    const response = await app.inject({ method: "POST", url: "/products", payload });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { code: "INVALID_REQUEST", message: "Dados da requisição inválidos." });
  }
  for (const query of [{ status: "bad" }, { lowStockOnly: "yes" }, { limit: "0" }, { limit: "1.5" }]) {
    const response = await app.inject({ method: "GET", url: "/products", query });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { code: "INVALID_REQUEST", message: "Dados da requisição inválidos." });
  }
  const count = await database.query<{ count: number }>("SELECT COUNT(*)::INT AS count FROM product");
  assert.equal(count.rows[0]?.count, 0);
});

test("duplicate_sku_or_barcode_returns_public_product_conflict_without_database_details", async () => {
  const input = command();
  input.product.variants[0]!.barcode = "789123";
  await service.create(input);
  const duplicateBarcode = command("Outro", "OTHER-SKU");
  duplicateBarcode.product.variants[0]!.barcode = "789123";
  for (const duplicate of [command(), duplicateBarcode]) {
    const response = await app.inject({ method: "POST", url: "/products", payload: duplicate });
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(response.json(), {
      code: "PRODUCT_CONFLICT", message: "Já existe uma variante com este SKU ou código de barras.",
    });
  }
});

test("incompatible_operation_replay_returns_public_payload_conflict", async () => {
  const input = command();
  await service.create(input);
  input.product.name = "Nome diferente";
  const response = await app.inject({ method: "POST", url: "/products", payload: input });
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), {
    code: "OPERATION_PAYLOAD_CONFLICT", message: "Esta operação já foi registrada com dados diferentes.",
  });
});

test("unexpected_database_error_returns_safe_500_and_is_logged_internally", async () => {
  const original = await service.create(command());
  let logs = "";
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const failureApp = Fastify({ logger: { stream: logStream } });
  const collidingService = createProductService({
    database, repository: createProductRepository(), idFactory: () => original.id,
  });
  await registerProductRoutes(failureApp, collidingService);
  try {
    const response = await failureApp.inject({
      method: "POST", url: "/products", payload: command("Outro", "NEW-SKU"),
    });
    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(response.json(), {
      code: "INTERNAL_ERROR", message: "Não foi possível concluir a operação.",
    });
    const entries = logs.trim().split("\n").map((line: string) => JSON.parse(line) as { level: number; err?: { code?: string } });
    assert.ok(entries.some((entry) => entry.level === 50 && entry.err?.code === "23505"));
  } finally {
    await failureApp.close();
  }
});

test("invalid_stored_catalog_data_is_an_internal_failure_instead_of_a_client_validation_error", async () => {
  await service.create(command());
  await database.query("UPDATE product_variant SET attributes = '{}'::JSONB");
  const response = await app.inject({ method: "GET", url: "/products" });
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(response.json(), {
    code: "INTERNAL_ERROR", message: "Não foi possível concluir a operação.",
  });
});

test("health_without_database_configuration_remains_available", async () => {
  const healthApp = createApp();
  try {
    const response = await healthApp.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
  } finally {
    await healthApp.close();
  }
});
