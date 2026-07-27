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
}

export interface ContainerVerifierInvocation {
  command: 'docker' | 'podman';
  args: string[];
  request: string;
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
  const kitDirectory = resolve(request.kitDirectory);
  const replayPath = resolve(request.replayPath);
  const memoryMiB = Math.max(16, Math.floor(limits.memoryBytes / (1024 * 1024)));
  const cpu = Math.max(0.01, limits.cpuMilliseconds / limits.wallMilliseconds);
  return {
    command: options.command ?? 'docker',
    args: [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
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
