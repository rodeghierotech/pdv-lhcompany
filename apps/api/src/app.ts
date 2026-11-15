import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { getDatabasePool } from "./infrastructure/database.js";
import { createProductRepository } from "./modules/products/product-repository.js";
import { registerProductRoutes } from "./modules/products/product-routes.js";
import { createProductService, type ProductService } from "./modules/products/product-service.js";

export function createApp(options: { database?: Pool } = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  let products: ProductService | undefined;
  function getProducts(): ProductService {
    // Health checks and app startup must not require a database connection or URL.
    products ??= createProductService({
      database: options.database ?? getDatabasePool(),
      repository: createProductRepository(),
    });
    return products;
  }

  app.get("/health", async () => ({ status: "ok" }));
  app.register(async (instance) => {
    await registerProductRoutes(instance, {
      create: (command) => getProducts().create(command),
      list: (query) => getProducts().list(query),
    });
  });

  return app;
}
