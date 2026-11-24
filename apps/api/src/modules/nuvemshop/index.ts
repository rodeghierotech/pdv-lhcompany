import type pg from 'pg';
import type { Env } from '../../config/env.js';
import { createNuvemshopClient } from './client.js';
import { createCredentialCipher } from './crypto.js';
import { recordRateLimit } from './deps.js';
import type { NuvemshopDeps } from './deps.js';

export type { NuvemshopDeps } from './deps.js';
export { startWorker, runCycle } from './worker.js';

export function createNuvemshopDeps(
  pool: pg.Pool,
  env: Env,
  overrides: Partial<NuvemshopDeps> = {},
): NuvemshopDeps {
  const deps: NuvemshopDeps = {
    pool,
    env,
    cipher: createCredentialCipher(env.JWT_SECRET, env.INTEGRATION_ENCRYPTION_KEY),
    makeApi: ({ storeId, accessToken }) =>
      createNuvemshopClient({
        apiBase: env.NUVEMSHOP_API_BASE,
        storeId,
        accessToken,
        userAgent: env.NUVEMSHOP_USER_AGENT,
        onRateLimit: ({ remaining }) => void recordRateLimit(deps, { remaining }),
      }),
    ...overrides,
  };
  return deps;
}
