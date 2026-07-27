import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import workerdPackage from 'workerd';

const {
  default: workerdPath,
  version: workerdVersion,
} = workerdPackage;

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = resolve(root, 'scripts/dmath-workerd.capnp');
const fixture = JSON.parse(await readFile(
  resolve(root, 'fixtures/dmath/dmath-1.vectors.json'),
  'utf8',
));
const port = 18_787;
const child = spawn(
  workerdPath,
  ['serve', config, 'config', '--socket-addr', `http=127.0.0.1:${port}`],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`workerd exited with ${child.exitCode}\n${output}`);
    }
    try {
      response = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        body: JSON.stringify(fixture),
        headers: { 'content-type': 'application/json' },
      });
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  if (!response?.ok) {
    throw new Error(`workerd did not return a successful response\n${output}`);
  }
  const actual = await response.json();
  const mismatches = fixture.flatMap((vector, index) => (
    actual[index] === vector.resultBits
      ? []
      : [{
        index,
        function: vector.function,
        expected: vector.resultBits,
        actual: actual[index],
      }]
  ));
  if (mismatches.length > 0) {
    throw new Error(`workerd dmath mismatch:\n${JSON.stringify(mismatches, null, 2)}`);
  }
  process.stdout.write(`workerd ${workerdVersion}: dmath-1 vectors passed\n`);
} finally {
  child.kill();
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once('exit', resolveExit);
  });
}
