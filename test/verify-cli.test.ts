import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createReplayArtifact,
  serializeReplayJsonl,
} from '../src/engine/index.js';
import { runVerifyCli } from '../src/verify-cli.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('gaos verify', () => {
  const artifact = (status: 'won' | 'failed') => createReplayArtifact({
    sessionId: 'cli-verify',
    game: {
      id: 'verify-test',
      version: '1',
      adapter: { id: 'verify-test', version: '1' },
    },
    seed: 1,
    seedPolicy: 'explicit',
    perm: [0],
    levels: [{
      id: 'one',
      seed: 1,
      level: {},
      result: { status, stars: status === 'won' ? 1 : null, actionsUsed: 1 },
    }],
    actions: [{
      n: 0,
      levelIndex: 0,
      tick: 0,
      wireId: 'Action 1',
      canonicalId: 'Action 1',
    }],
    records: [{
      kind: 'resolution',
      n: 0,
      levelIndex: 0,
      tick: 0,
      inputs: [{ wireId: 'Action 1', canonicalId: 'Action 1' }],
      cause: 'complete',
    }],
  });

  it('prints an offline verdict and exits non-zero only for rejected evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gaos-verify-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'adapter.mjs'), `
const reducer = {
  init: () => ({ actionsUsed: 0 }),
  advance: (state) => ({ actionsUsed: state.actionsUsed + 1 }),
  view: (state) => ({
    actions: [{ id: 'Action 1', params: 'none' }],
    status: state.actionsUsed > 0 ? 'won' : 'playing',
    ...(state.actionsUsed > 0 ? { stars: 1 } : {}),
    hud: { actionsUsed: state.actionsUsed }
  })
};
export default () => reducer;
`);
    writeFileSync(join(directory, 'valid.jsonl'), serializeReplayJsonl(artifact('won')));
    writeFileSync(join(directory, 'rejected.jsonl'), serializeReplayJsonl(artifact('failed')));

    let output = '';
    const validCode = await runVerifyCli([
      'verify',
      'valid.jsonl',
      '--adapter',
      'adapter.mjs',
      '--json',
    ], {
      cwd: directory,
      stdout: (text) => { output += text; },
      stderr: () => undefined,
    });
    expect(validCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      verdict: 'unverifiable',
      replayOk: true,
      formatVersion: '1.3',
      signatures: { state: 'unsigned' },
    });

    output = '';
    const rejectedCode = await runVerifyCli([
      'verify',
      'rejected.jsonl',
      '--adapter',
      'adapter.mjs',
      '--json',
    ], {
      cwd: directory,
      stdout: (text) => { output += text; },
      stderr: () => undefined,
    });
    expect(rejectedCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      verdict: 'rejected',
      replayOk: false,
    });
  });
});
