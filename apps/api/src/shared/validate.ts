import type { z } from 'zod';
import { errors } from './errors.js';

/** Valida dados externos com zod e converte falhas em erro 400 padronizado. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw errors.validation(
      'Dados inválidos',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Escapa curingas do LIKE/ILIKE para busca literal. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
