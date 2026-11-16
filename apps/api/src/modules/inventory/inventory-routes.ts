import {
  CreateReplenishmentCommandSchema, InventoryHistoryQuerySchema, ProductVariantSchema,
} from "@lh-company/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { InventoryOperationNotAllowedError, InventoryVariantNotFoundError, OperationPayloadConflictError } from "./inventory-errors.js";
import type { InventoryService } from "./inventory-service.js";

const VariantParamsSchema = z.strictObject({ variantId: ProductVariantSchema.shape.id });

function sendFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof InventoryVariantNotFoundError) {
    return reply.code(404).send({ code: error.code, message: error.message });
  }
  if (error instanceof InventoryOperationNotAllowedError || error instanceof OperationPayloadConflictError) {
    return reply.code(409).send({ code: error.code, message: error.message });
  }
  request.log.error({ err: error }, "Falha na operação de estoque.");
  return reply.code(500).send({ code: "INTERNAL_ERROR", message: "Não foi possível concluir a operação." });
}

export async function registerInventoryRoutes(app: FastifyInstance, service: InventoryService): Promise<void> {
  app.post("/inventory/replenishments", async (request, reply) => {
    const command = CreateReplenishmentCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "Dados da requisição inválidos." });
    }
    try {
      return reply.code(201).send(await service.replenish(command.data));
    } catch (error) {
      return sendFailure(error, request, reply);
    }
  });

  app.get("/inventory/variants/:variantId/history", async (request, reply) => {
    const params = VariantParamsSchema.safeParse(request.params);
    const query = InventoryHistoryQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "Dados da requisição inválidos." });
    }
    try {
      return await service.getHistory(params.data.variantId, query.data);
    } catch (error) {
      return sendFailure(error, request, reply);
    }
  });
}
