import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { importExternalModule } from '../src/module-loader.js';

it('loads an external ESM module outside the project', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaos-module-loader-'));
  writeFileSync(
    join(directory, 'dependency.mjs'),
    'export const base = 40;\n',
  );
  const modulePath = join(directory, 'adapter.mjs');
  writeFileSync(modulePath, `
import { base } from './dependency.mjs';
export const value = await Promise.resolve(base + 2);
export default () => value;
`);

  try {
    const imported = await importExternalModule<{
      default: () => number;
      value: number;
    }>(
      pathToFileURL(modulePath).href,
    );
    expect(imported.value).toBe(42);
    expect(imported.default()).toBe(42);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
