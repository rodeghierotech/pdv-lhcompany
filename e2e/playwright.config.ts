import { defineConfig } from '@playwright/test';

const WEB = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
/** Build de produção servido por `vite preview`: o Service Worker só existe aqui (testes offline). */
export const PREVIEW = process.env.E2E_PREVIEW_URL ?? 'http://localhost:4173';
const API_PORT = process.env.E2E_API_PORT ?? '3333';

/**
 * E2E contra servidores reais (API + web) e PostgreSQL. Requisitos:
 *  - DATABASE_URL de um banco DE DESENVOLVIMENTO/TESTE já migrado (`pnpm db:migrate`);
 *  - um administrador (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD).
 * Os testes criam os próprios produtos/clientes (SKU único) e fecham o caixa do admin ao final.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalTimeout: 15 * 60_000,
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    locale: 'pt-BR',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  webServer: [
    {
      command: 'pnpm --filter @pdv/api dev',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        PORT: API_PORT,
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://pdv:pdv_dev@localhost:5432/pdv_dev',
        JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-secret-e2e-secret-e2e-secret-123',
        LOGIN_RATE_LIMIT: '1000',
        CORS_ORIGINS: `${WEB},${PREVIEW}`,
      },
    },
    {
      command:
        'pnpm --filter @pdv/web build && pnpm --filter @pdv/web preview --port 4173 --strictPort',
      url: PREVIEW,
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: 'pnpm --filter @pdv/web dev',
      url: WEB,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
