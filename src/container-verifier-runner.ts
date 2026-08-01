import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  type RestrictedVerifierRequest,
  type RestrictedVerifierResponse,
  type RestrictedVerifierRunner,
} from './verifier-kit.js';

export interface ContainerVerifierRunnerOptions {
  /** Immutable image reference, for example registry/repo@sha256:<64 hex>. */
  image: string;
  command?: 'docker' | 'podman';
  /** Numeric container uid or uid:gid. Defaults to the non-root uid 65532. */
  user?: string;
}

export interface ContainerVerifierInvocation {
  command: 'docker' | 'podman';
  args: string[];
  request: string;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

/**
 * Build the auditable container invocation used for automatically resolved
 * verifier code. No network, host environment, writable root, or extra
 * processes are granted.
 */
export function containerVerifierInvocation(
  options: ContainerVerifierRunnerOptions,
  request: RestrictedVerifierRequest,
  limits: Parameters<RestrictedVerifierRunner['run']>[1],
): ContainerVerifierInvocation {
  if (!/@sha256:[0-9a-f]{64}$/.test(options.image)) {
    throw new TypeError('restricted verifier image must be pinned by SHA-256 digest');
  }
  const user = options.user ?? '65532:65532';
  if (!/^[1-9][0-9]*(?::[1-9][0-9]*)?$/.test(user)) {
    throw new TypeError('restricted verifier user must be a non-root numeric uid or uid:gid');
  }
  assertPositiveSafeInteger(limits.cpuMilliseconds, 'cpuMilliseconds');
  assertPositiveSafeInteger(limits.wallMilliseconds, 'wallMilliseconds');
  assertPositiveSafeInteger(limits.memoryBytes, 'memoryBytes');
  assertPositiveSafeInteger(limits.processes, 'processes');
  assertPositiveSafeInteger(limits.outputBytes, 'outputBytes');
  if (limits.wallMilliseconds > 2_147_483_647) {
    throw new RangeError('wallMilliseconds exceeds the supported timer range');
  }
  if (limits.memoryBytes < 16 * 1024 * 1024) {
    throw new RangeError('memoryBytes must be at least 16 MiB');
  }
  const kitDirectory = resolve(request.kitDirectory);
  const replayPath = resolve(request.replayPath);
  const memoryMiB = Math.floor(limits.memoryBytes / (1024 * 1024));
  const cpu = limits.cpuMilliseconds / limits.wallMilliseconds;
  if (cpu < 0.01) {
    throw new RangeError('cpuMilliseconds must provide at least 0.01 CPUs');
  }
  return {
    command: options.command ?? 'docker',
    args: [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--user',
      user,
      '--pids-limit',
      String(limits.processes),
      '--memory',
      `${memoryMiB}m`,
      '--cpus',
      String(cpu),
      '--env',
      'PATH=/usr/bin:/bin',
      '--mount',
      `type=bind,source=${kitDirectory},target=/gaos/kit,readonly`,
      '--mount',
      `type=bind,source=${replayPath},target=/gaos/replay.jsonl,readonly`,
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=16m',
      options.image,
    ],
    request: `${JSON.stringify({
      ...request,
      kitDirectory: '/gaos/kit',
      replayPath: '/gaos/replay.jsonl',
    })}\n`,
  };
}

/** Pinned-container implementation of the RFC-016 restricted runner boundary. */
export class ContainerVerifierRunner implements RestrictedVerifierRunner {
  readonly #options: ContainerVerifierRunnerOptions;

  constructor(options: ContainerVerifierRunnerOptions) {
    this.#options = { ...options };
  }

  async run(
    request: RestrictedVerifierRequest,
    limits: Parameters<RestrictedVerifierRunner['run']>[1],
  ): Promise<RestrictedVerifierResponse> {
    const invocation = containerVerifierInvocation(this.#options, request, limits);
    return new Promise((accept, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new TypeError('restricted verifier exceeded wall-time limit')));
      }, limits.wallMilliseconds);
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > limits.outputBytes) {
          child.kill('SIGKILL');
          finish(() => reject(new TypeError('restricted verifier exceeded output limit')));
          return;
        }
        output.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (errors.reduce((sum, part) => sum + part.length, 0) < limits.outputBytes) {
          errors.push(chunk);
        }
      });
      child.once('error', (error) => finish(() => reject(error)));
      child.stdin.once('error', (error) => finish(() => reject(error)));
      child.once('close', (code) => {
        finish(() => {
          if (code !== 0) {
            reject(new TypeError(
              `restricted verifier exited with ${String(code)}: `
              + Buffer.concat(errors).toString('utf8').trim(),
            ));
            return;
          }
          try {
            accept(JSON.parse(Buffer.concat(output).toString('utf8')));
          } catch {
            reject(new TypeError('restricted verifier returned malformed JSON'));
          }
        });
      });
      child.stdin.end(invocation.request);
    });
  }
}
