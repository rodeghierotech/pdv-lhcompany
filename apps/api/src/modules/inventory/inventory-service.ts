import { createHash, randomUUID } from "node:crypto";

import {
  CreateReplenishmentCommandSchema, InventoryHistoryQuerySchema, ProductVariantSchema,
  type CreateReplenishmentCommand, type InventoryHistoryQuery, type InventoryHistoryResponse,
} from "@lh-company/contracts";
import type { Pool, PoolClient } from "pg";

import { withinTransaction } from "../../infrastructure/database.js";
import { calculateWeightedAverageCost } from "./inventory-domain.js";
import { InventoryOperationNotAllowedError, InventoryVariantNotFoundError, OperationPayloadConflictError } from "./inventory-errors.js";
import type { InventoryOperation, InventoryRepository } from "./inventory-repository.js";

export interface InventoryService {
  replenish(command: CreateReplenishmentCommand): Promise<InventoryHistoryResponse>;
  getHistory(variantId: string, query: InventoryHistoryQuery): Promise<InventoryHistoryResponse>;
}

interface InventoryServiceDependencies {
  database: Pool;
  repository: InventoryRepository;
  idFactory?: () => string;
  clock?: () => Date;
}

function isOperationRace(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505"
    && "constraint" in error && error.constraint === "inventory_movement_operation_id_key";
}

export function createInventoryService({
  database, repository, idFactory = randomUUID, clock = () => new Date(),
}: InventoryServiceDependencies): InventoryService {
  const mutationHistoryQuery = InventoryHistoryQuerySchema.parse({});

  async function history(client: PoolClient, variantId: string, query: InventoryHistoryQuery) {
    const snapshot = await repository.getHistory(client, variantId, query);
    if (!snapshot) { throw new InventoryVariantNotFoundError(); }
    return snapshot;
  }

  async function replay(client: PoolClient, operation: InventoryOperation, fingerprint: string) {
    if (operation.fingerprint !== fingerprint) { throw new OperationPayloadConflictError(); }
    return history(client, operation.variantId, mutationHistoryQuery);
  }

  return {
    async getHistory(variantId, input) {
      ProductVariantSchema.shape.id.parse(variantId);
      const query = InventoryHistoryQuerySchema.parse(input);
      const client = await database.connect();
      try { return await history(client, variantId, query); } finally { client.release(); }
    },
    async replenish(input) {
      const command = CreateReplenishmentCommandSchema.parse(input);
      const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      try {
        return await withinTransaction(async (client) => {
          const existing = await repository.findByOperationId(client, command.operationId);
          if (existing) { return replay(client, existing, fingerprint); }
          const variant = await repository.lockVariant(client, command.variantId);
          if (!variant) { throw new InventoryVariantNotFoundError(); }
          // A concurrent operation on this variant may have committed while we waited for its lock.
          const committed = await repository.findByOperationId(client, command.operationId);
          if (committed) { return replay(client, committed, fingerprint); }
          if (!variant.productActive || !variant.variantActive || !variant.tracksInventory) {
            throw new InventoryOperationNotAllowedError();
          }
          const currentQuantity = await repository.lockBalance(client, command.variantId);
          const newCostInCents = calculateWeightedAverageCost({
            currentQuantity, currentUnitCostInCents: variant.costInCents,
            incomingQuantity: command.quantity, incomingUnitCostInCents: command.unitCostInCents,
          });
          const occurredAt = clock();
          await repository.insert(client, {
            ...command, fingerprint, lotId: idFactory(), movementId: idFactory(),
            sourceReference: command.sourceReference ?? null, occurredAt,
            newQuantity: currentQuantity + command.quantity, newCostInCents,
          });
          return history(client, command.variantId, mutationHistoryQuery);
        }, database);
      } catch (error) {
        if (!isOperationRace(error)) { throw error; }
        // A race across different variants can hit the operation's unique constraint.
        // Read the committed winner only after the losing transaction has rolled back.
        return withinTransaction(async (client) => {
          const winner = await repository.findByOperationId(client, command.operationId);
          if (!winner) { throw error; }
          return replay(client, winner, fingerprint);
        }, database);
      }
    },
  };
}
