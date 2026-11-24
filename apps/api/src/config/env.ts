import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
  DATABASE_URL_MIGRATIONS: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter ao menos 32 caracteres'),
  ACCESS_TOKEN_TTL: z.string().default('8h'),
  /** Limite de tentativas de login por minuto e IP (a suíte E2E eleva para não se auto-bloquear). */
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  // --- Integração Nuvemshop (opcional; sem credenciais o módulo fica "não configurado") ---
  NUVEMSHOP_APP_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  NUVEMSHOP_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  /** Versão da Admin API no caminho (documentação: 2025-03). */
  NUVEMSHOP_API_BASE: z.string().url().default('https://api.nuvemshop.com.br/2025-03'),
  /** Base do fluxo OAuth (https://www.nuvemshop.com.br/apps/{app_id}/authorize). */
  NUVEMSHOP_AUTH_BASE: z.string().url().default('https://www.nuvemshop.com.br'),
  /** O header User-Agent é obrigatório (sem ele a API responde 400). */
  NUVEMSHOP_USER_AGENT: z.string().min(3).default('PDV LH Company (contato@rodeghiero.tech)'),
  /** URL pública HTTPS desta API (destino dos webhooks e do callback OAuth). */
  PUBLIC_API_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /** URL do frontend (redirecionamento após o OAuth). */
  WEB_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /** Chave de cifragem das credenciais (32+ chars). Padrão: derivada do JWT_SECRET (HKDF). */
  INTEGRATION_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  /** Intervalo do worker (ms) e da reconciliação (min). */
  WORKER_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
  RECONCILE_INTERVAL_MIN: z.coerce.number().int().min(1).default(30),
});

export type Env = z.infer<typeof envSchema> & { corsOrigins: string[] };

/** Carrega o .env (somente fora de produção) sem sobrescrever variáveis já definidas. */
function loadDotenv(): void {
  if (process.env.NODE_ENV === 'production') return;
  for (const candidate of ['.env', '../../.env']) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return;
    }
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env) loadDotenv();
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${problems}`);
  }
  return {
    ...parsed.data,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
