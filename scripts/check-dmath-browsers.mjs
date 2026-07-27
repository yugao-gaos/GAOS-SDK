/**
 * Run the frozen dmath-1 vectors in the browser engines named by RFC-007.
 *
 * Install the matching browser binaries first:
 *   npx playwright install chromium firefox webkit
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>dmath runtime check</title>');
      return;
    }
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader('content-type', contentTypes.get(extname(file)) ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP');
const origin = `http://127.0.0.1:${address.port}`;

const engines = { chromium, firefox, webkit };
try {
  for (const [name, engine] of Object.entries(engines)) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      const mismatches = await page.evaluate(async (base) => {
        const { createDmath } = await import(`${base}/dist/engine/dmath.js`);
        const vectors = await fetch(`${base}/fixtures/dmath/dmath-1.vectors.json`).then(
          (response) => response.json(),
        );
        const dmath = createDmath();
        const bits = (value) => {
          const buffer = new ArrayBuffer(8);
          new DataView(buffer).setFloat64(0, value, false);
          return [...new Uint8Array(buffer)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
        };
        return vectors.flatMap((vector, index) => {
          const args = vector.args.map((value) => value === '-0' ? -0 : value);
          let result;
          if (vector.function === 'atan2') result = dmath.atan2(args[0], args[1]);
          else if (vector.function === 'clamp') result = dmath.clamp(args[0], args[1], args[2]);
          else if (vector.function === 'roundTo') result = dmath.roundTo(args[0], args[1]);
          else result = dmath[vector.function](args[0]);
          const actual = bits(result);
          return actual === vector.resultBits
            ? []
            : [{ index, function: vector.function, expected: vector.resultBits, actual }];
        });
      }, origin);
      if (mismatches.length > 0) {
        throw new Error(`${name} dmath mismatch:\n${JSON.stringify(mismatches, null, 2)}`);
      }
      process.stdout.write(`${name} ${browser.version()}: dmath-1 vectors passed\n`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolveClose, reject) => server.close(
    (error) => error ? reject(error) : resolveClose(),
  ));
}
