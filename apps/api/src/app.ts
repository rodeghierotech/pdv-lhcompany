import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { getDatabasePool } from "./infrastructure/database.js";
import { createInventoryRepository } from "./modules/inventory/inventory-repository.js";
import { registerInventoryRoutes } from "./modules/inventory/inventory-routes.js";
import { createInventoryService, type InventoryService } from "./modules/inventory/inventory-service.js";
import { createProductRepository } from "./modules/products/product-repository.js";
import { registerProductRoutes } from "./modules/products/product-routes.js";
import { createProductService, type ProductService } from "./modules/products/product-service.js";

export function createApp(options: { database?: Pool } = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  let products: ProductService | undefined;
  let inventory: InventoryService | undefined;
  function getProducts(): ProductService {
    // Health checks and app startup must not require a database connection or URL.
    products ??= createProductService({
      database: options.database ?? getDatabasePool(),
      repository: createProductRepository(),
    });
    return products;
  }
  function getInventory(): InventoryService {
    inventory ??= createInventoryService({
      database: options.database ?? getDatabasePool(),
      repository: createInventoryRepository(),
    });
    return inventory;
  }

  app.get("/health", async () => ({ status: "ok" }));
  app.register(async (instance) => {
    await registerProductRoutes(instance, {
      create: (command) => getProducts().create(command),
      list: (query) => getProducts().list(query),
    });
    await registerInventoryRoutes(instance, {
      replenish: (command) => getInventory().replenish(command),
      getHistory: (variantId, query) => getInventory().getHistory(variantId, query),
    });
  });

  return app;
}
