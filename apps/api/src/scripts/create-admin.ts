import { userCreateSchema } from '@pdv/shared';
import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { createUser } from '../modules/auth/service.js';

/** Cria o primeiro administrador a partir de ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD. */
const env = loadEnv();
const parsed = userCreateSchema.safeParse({
  name: process.env.ADMIN_NAME,
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
  role: 'admin',
});

if (!parsed.success) {
  console.error(
    'Defina ADMIN_NAME, ADMIN_EMAIL e ADMIN_PASSWORD (mín. 10 caracteres) no ambiente:',
    parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  );
  process.exit(1);
}

const pool = createPool(env.DATABASE_URL);
try {
  const user = await createUser(pool, parsed.data, null);
  console.log(`Administrador criado: ${user.email}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
