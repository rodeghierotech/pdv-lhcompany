import type pg from 'pg';
import type { Role, UserCreateInput, UserDTO } from '@pdv/shared';
import { maybeOne, one, withTransaction } from '../../db/pool.js';
import { AppError, errors, PG, pgErrorCode } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  password_hash: string;
}

const toDTO = (u: UserRow): UserDTO => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export async function authenticate(
  pool: pg.Pool,
  email: string,
  password: string,
): Promise<UserDTO> {
  const user = await maybeOne<UserRow>(
    pool,
    'select id, name, email, role, active, password_hash from users where lower(email) = lower($1)',
    [email],
  );
  // Sempre executa uma verificação para não vazar a existência do e-mail pelo tempo de resposta.
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !user.active) {
    throw errors.unauthorized('E-mail ou senha inválidos');
  }
  return toDTO(user);
}

export async function getActiveUser(pool: pg.Pool, id: string): Promise<UserDTO | null> {
  const user = await maybeOne<UserRow>(
    pool,
    'select id, name, email, role, active, password_hash from users where id = $1',
    [id],
  );
  return user && user.active ? toDTO(user) : null;
}

export async function createUser(
  pool: pg.Pool,
  input: UserCreateInput,
  actorId: string | null,
): Promise<UserDTO> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTransaction(pool, async (tx) => {
      const user = await one<UserRow>(
        tx,
        `insert into users (name, email, password_hash, role)
         values ($1, $2, $3, $4)
         returning id, name, email, role, active, password_hash`,
        [input.name, input.email, passwordHash, input.role],
      );
      await recordAudit(tx, {
        actorId,
        action: 'user.create',
        entity: 'user',
        entityId: user.id,
        payload: { email: user.email, role: user.role },
      });
      return toDTO(user);
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (pgErrorCode(err) === PG.uniqueViolation) {
      throw errors.conflict('EMAIL_IN_USE', 'Já existe um usuário com este e-mail');
    }
    throw err;
  }
}
