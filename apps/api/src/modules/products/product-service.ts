import { createHash, randomUUID } from "node:crypto";

import {
  CreateProductCommandSchema,
  type CreateProductCommand,
  type Product,
} from "@lh-company/contracts";
import type { Pool } from "pg";

import { withinTransaction } from "../../infrastructure/database.js";
import { OperationPayloadConflictError, ProductConflictError } from "./product-errors.js";
import type { ProductOperation, ProductRepository } from "./product-repository.js";

export interface ProductService {
  create(command: CreateProductCommand): Promise<Product>;
}

interface ProductServiceDependencies {
  database: Pool;
  repository: ProductRepository;
  idFactory?: () => string;
}

function uniqueConstraint(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505"
    && "constraint" in error && typeof error.constraint === "string") {
    return error.constraint;
  }
  return undefined;
}

function replay(operation: ProductOperation, fingerprint: string): Product {
  if (operation.fingerprint !== fingerprint) {
    throw new OperationPayloadConflictError();
  }
  return operation.product;
}

export function createProductService({
  database,
  repository,
  idFactory = randomUUID,
}: ProductServiceDependencies): ProductService {
  return {
    async create(input) {
      const command = CreateProductCommandSchema.parse(input);
      // Zod gives every object a fixed field order and normalizes defaults and text.
      // Server-generated product/variant IDs never participate in this payload.
      const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      try {
        return await withinTransaction(async (client) => {
          const existing = await repository.findByOperationId(client, command.operationId);
          if (existing) {
            return replay(existing, fingerprint);
          }
          const productId = idFactory();
          const product: Product = {
            ...command.product,
            id: productId,
            variants: command.product.variants.map((variant) => ({
              ...variant,
              id: idFactory(),
              productId,
            })),
          };
          return repository.insert(client, { product, operationId: command.operationId, fingerprint });
        }, database);
      } catch (error) {
        const constraint = uniqueConstraint(error);
        if (constraint === "product_operation_id_key") {
          // The losing transaction has rolled back. Read the committed winner
          // using a new transaction, including its complete variant aggregate.
          return withinTransaction(async (client) => {
            const winner = await repository.findByOperationId(client, command.operationId);
            if (!winner) {
              throw error;
            }
            return replay(winner, fingerprint);
          }, database);
        }
        if (constraint === "product_variant_sku_key" || constraint === "product_variant_barcode_key") {
          throw new ProductConflictError();
        }
        throw error;
      }
    },
  };
}
