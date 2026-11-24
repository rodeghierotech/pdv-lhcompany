import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  categoryCreateSchema,
  productCreateSchema,
  productListQuerySchema,
  productUpdateSchema,
  variantCreateSchema,
  variantUpdateSchema,
} from '@pdv/shared';
import { parse } from '../../shared/validate.js';
import {
  addVariant,
  createCategory,
  createProduct,
  getProduct,
  listCategories,
  listProducts,
  updateProduct,
  updateVariant,
} from './service.js';
import type pg from 'pg';

const idParams = z.object({ id: z.string().uuid() });

export const catalogRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  const read = { preHandler: app.requirePermission('product:read') };
  const write = { preHandler: app.requirePermission('product:write') };

  app.get('/categories', read, async () => ({ items: await listCategories(pool) }));

  app.post('/categories', write, async (request, reply) => {
    const { name } = parse(categoryCreateSchema, request.body);
    return reply.code(201).send({ category: await createCategory(pool, name, request.actor.id) });
  });

  app.get('/products', read, async (request) =>
    listProducts(pool, parse(productListQuerySchema, request.query)),
  );

  app.get('/products/:id', read, async (request) => {
    const { id } = parse(idParams, request.params);
    return { product: await getProduct(pool, id) };
  });

  app.post('/products', write, async (request, reply) => {
    const input = parse(productCreateSchema, request.body);
    const { product, created } = await createProduct(pool, input, request.actor.id);
    return reply.code(created ? 201 : 200).send({ product, replayed: !created });
  });

  app.patch('/products/:id', write, async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(productUpdateSchema, request.body);
    return { product: await updateProduct(pool, id, input, request.actor.id) };
  });

  app.post('/products/:id/variants', write, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const input = parse(variantCreateSchema, request.body);
    return reply.code(201).send({ product: await addVariant(pool, id, input, request.actor.id) });
  });

  app.patch('/variants/:id', write, async (request) => {
    const { id } = parse(idParams, request.params);
    const input = parse(variantUpdateSchema, request.body);
    return { variant: await updateVariant(pool, id, input, request.actor.id) };
  });
};
