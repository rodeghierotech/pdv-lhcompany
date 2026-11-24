import { defineConfig } from 'tsup';
import { cpSync } from 'node:fs';

export default defineConfig({
  entry: [
    'src/server.ts',
    'src/worker.ts',
    'src/scripts/migrate.ts',
    'src/scripts/create-admin.ts',
  ],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Embute o pacote compartilhado (exportado como TS fonte).
  noExternal: ['@pdv/shared'],
  onSuccess: async () => {
    cpSync('src/db/migrations', 'dist/scripts/migrations', { recursive: true });
    cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
  },
});
