import { CreateProductCommandSchema, ProductCatalogQuerySchema } from "@lh-company/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { OperationPayloadConflictError, ProductConflictError } from "./product-errors.js";
import type { ProductService } from "./product-service.js";

function sendFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ProductConflictError || error instanceof OperationPayloadConflictError) {
    return reply.code(409).send({ code: error.code, message: error.message });
  }
  request.log.error({ err: error }, "Falha na operação de produtos.");
  return reply.code(500).send({ code: "INTERNAL_ERROR", message: "Não foi possível concluir a operação." });
}

export async function registerProductRoutes(app: FastifyInstance, service: ProductService): Promise<void> {
  app.get("/products", async (request, reply) => {
    const query = ProductCatalogQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "Dados da requisição inválidos." });
    }
    try {
      return await service.list(query.data);
    } catch (error) {
      return sendFailure(error, request, reply);
    }
  });

  app.post("/products", async (request, reply) => {
    const command = CreateProductCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "Dados da requisição inválidos." });
    }
    try {
      const product = await service.create(command.data);
      return reply.code(201).send(product);
    } catch (error) {
      return sendFailure(error, request, reply);
    }
  });
}
