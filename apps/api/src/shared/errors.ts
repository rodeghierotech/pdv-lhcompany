export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  unauthorized: (message = 'Não autenticado') => new AppError('UNAUTHORIZED', 401, message),
  forbidden: (message = 'Sem permissão para esta ação') => new AppError('FORBIDDEN', 403, message),
  notFound: (what = 'Recurso') => new AppError('NOT_FOUND', 404, `${what}: não encontrado`),
  conflict: (code: string, message: string, details?: unknown) =>
    new AppError(code, 409, message, details),
  validation: (message: string, details?: unknown) =>
    new AppError('VALIDATION_ERROR', 400, message, details),
  unprocessable: (code: string, message: string) => new AppError(code, 422, message),
};

/** Códigos de erro do PostgreSQL relevantes. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  restrictViolation: '23001',
} as const;

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'constraint' in err) {
    const c = (err as { constraint?: unknown }).constraint;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}
