import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        statements: 78,
        branches: 70,
        functions: 85,
        lines: 78,
      },
    },
  },
  server: {
    fs: {
      // The CLI accepts external environment modules; its integration test creates one here.
      allow: [searchForWorkspaceRoot(process.cwd()), realpathSync(tmpdir())],
    },
  },
});
