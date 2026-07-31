import { accessSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
const repository = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'gaos-package-smoke-'));

function runNpm(args, options) {
  if (npmCli) {
    return execFileSync(process.execPath, [npmCli, ...args], options);
  }
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

try {
  const packed = runNpm(
    ['pack', '--silent', '--pack-destination', temporary],
    { cwd: repository, encoding: 'utf8' },
  ).trim().split(/\r?\n/).at(-1);
  if (!packed) throw new Error('npm pack did not report an archive');

  runNpm(['init', '-y'], { cwd: temporary, stdio: 'ignore' });
  runNpm(['install', join(temporary, packed)], {
    cwd: temporary,
    stdio: 'ignore',
  });
  execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      "const sdk = '@yugao-gaos/gaos-sdk';",
      "const engine = await import(`${sdk}/engine`);",
      "if (engine.GAOS_REPLAY_FORMAT_VERSION !== '1.3') process.exit(1);",
      "for (const entry of ['session-host', 'benchmark', 'ecosystem', 'evidence',",
      "  'leaderboard', 'presentation-client', 'seat-control']) {",
      "  await import(`${sdk}/${entry}`);",
      '}',
    ].join('\n'),
  ], { cwd: temporary, stdio: 'inherit' });

  for (const path of [
    'schemas/gaos.replay-v1.schema.json',
    'schemas/gaos.benchmark-bundle-v1.schema.json',
    'fixtures/replay/gaos-replay-v1.golden.jsonl',
    'fixtures/replay/gaos-replay-v1.3-ended.golden.jsonl',
    'fixtures/signatures/gaos.submission.ed25519.v2.vectors.json',
  ]) {
    accessSync(join(temporary, 'node_modules/@yugao-gaos/gaos-sdk', path));
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
