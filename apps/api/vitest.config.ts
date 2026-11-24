import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false, // testes compartilham o mesmo PostgreSQL
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
      DATABASE_URL:
        process.env.DATABASE_URL_TEST ?? 'postgres://pdv:pdv_dev@localhost:5432/pdv_test',
    },
  },
});
