import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDefaultKeyedProviderRegistry,
  createKeyedAgentDriver,
  runAgentDriverEpisode,
} from '../agent/index.js';
import type { AgentEnvironment } from '../engine/agent-environment.js';
import type { TickView } from '../engine/contracts.js';
import { createDefaultCliAgentRegistry } from './specs.js';
import { inspectCliAgent } from './status.js';
import { spawnCliAgent } from './spawn.js';

export interface AgentCliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string>;
}

const HELP = `gaos-agent — run keyed or installed CLI agents against tick-based game environments

Commands:
  drivers
      List built-in keyed providers and MCP-capable CLI agents.
  status [cli-id]
      Check whether CLI agents are installed and authenticated.
  check <provider>
      Validate the provider key from its standard environment variable.
  spawn <cli-id> --mcp-url <url> --prompt <text> [--server-name game] [--tools observe,act]
      Launch an installed CLI agent against an MCP endpoint in a scratch directory.
  run <provider> --module <file> [--model <id>] [--seed <uint32>] [--prompt <system prompt>]
      Load createEnvironment({ seed }) from an ESM module and run a keyed agent episode.

Keys are read only from ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY, or
OPENROUTER_API_KEY. They are never accepted as command arguments.

Custom CLI recipes can be supplied through GAOS_AGENT_CLIS as documented by
customCliAgentsFromJson in @yugao-gaos/turn-based-grid-sdk/agent-cli.
OLLAMA_MODEL selects the model used by the built-in Ollama recipe (default: qwen3.5).
`;

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const optionValue = args[++index];
    if (optionValue === undefined || optionValue.startsWith('--')) {
      throw new TypeError(`option --${name} requires a value`);
    }
    options.set(name, optionValue);
  }
  return { positionals, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new TypeError(`missing required option --${name}`);
  return value;
}

function assertOptions(options: Map<string, string>, allowed: readonly string[]): void {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) throw new TypeError(`unknown option --${name}`);
  }
}

function seedOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError('--seed must be an unsigned 32-bit integer');
  }
  return seed;
}

function defaultIo(): AgentCliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
  };
}

function cliRegistry(env: NodeJS.ProcessEnv) {
  return createDefaultCliAgentRegistry({
    customAgentsJson: env.GAOS_AGENT_CLIS,
    ollamaModel: env.OLLAMA_MODEL,
  });
}

async function listDrivers(io: AgentCliIO): Promise<number> {
  const cli = cliRegistry(io.env).list().map((agent) => ({
    id: agent.id,
    type: 'cli',
    label: agent.label,
    bin: agent.bin,
  }));
  const keyed = createDefaultKeyedProviderRegistry().list().map((provider) => ({
    id: `key:${provider.id}`,
    type: 'keyed',
    label: provider.label,
    model: provider.defaultModel,
    apiKeyEnv: provider.apiKeyEnv,
  }));
  io.stdout(`${JSON.stringify([...cli, ...keyed], null, 2)}\n`);
  return 0;
}

async function status(args: ParsedArguments, io: AgentCliIO): Promise<number> {
  assertOptions(args.options, []);
  const registry = cliRegistry(io.env);
  const id = args.positionals[0];
  const agents = id ? [registry.require(id)] : registry.list();
  const results = await Promise.all(agents.map((agent) => inspectCliAgent(agent, { path: io.env.PATH })));
  io.stdout(`${JSON.stringify(results, null, 2)}\n`);
  return results.every(({ installed, auth }) => installed && auth !== 'none') ? 0 : 1;
}

async function check(args: ParsedArguments, io: AgentCliIO): Promise<number> {
  assertOptions(args.options, []);
  const id = args.positionals[0];
  if (!id) throw new TypeError('check requires a provider id');
  const provider = createDefaultKeyedProviderRegistry().require(id);
  const result = await provider.check(io.env[provider.apiKeyEnv] ?? '');
  io.stdout(`${JSON.stringify({ provider: provider.id, ...result })}\n`);
  if (!result.ok) io.stderr(`${provider.login}\n`);
  return result.ok ? 0 : 1;
}

async function spawnAgent(args: ParsedArguments, io: AgentCliIO): Promise<number> {
  assertOptions(args.options, ['mcp-url', 'prompt', 'server-name', 'tools']);
  const id = args.positionals[0];
  if (!id) throw new TypeError('spawn requires a CLI agent id');
  const spec = cliRegistry(io.env).require(id);
  const launched = spawnCliAgent(spec, {
    mcpUrl: required(args.options, 'mcp-url'),
    prompt: required(args.options, 'prompt'),
    serverName: args.options.get('server-name'),
    toolNames: args.options.get('tools')?.split(',').map((tool) => tool.trim()).filter(Boolean),
  }, {
    env: io.env,
    onStdout: io.stdout,
    onStderr: io.stderr,
  });
  const stop = () => launched.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await launched.completion;
    if (result.code && result.stderrTail) io.stderr(`${result.stderrTail}\n`);
    return result.code ?? (result.signal ? 1 : 0);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

type EnvironmentFactory = (options: {
  seed?: number;
}) => AgentEnvironment<unknown, unknown, TickView<unknown, unknown>>
  | Promise<AgentEnvironment<unknown, unknown, TickView<unknown, unknown>>>;

async function runKeyed(args: ParsedArguments, io: AgentCliIO): Promise<number> {
  assertOptions(args.options, ['module', 'model', 'seed', 'prompt']);
  const providerId = args.positionals[0];
  if (!providerId) throw new TypeError('run requires a keyed provider id');
  const provider = createDefaultKeyedProviderRegistry().require(providerId);
  const apiKey = io.env[provider.apiKeyEnv] ?? '';
  if (!apiKey) throw new TypeError(`missing ${provider.apiKeyEnv}`);

  const modulePath = resolve(io.cwd, required(args.options, 'module'));
  const loaded = await import(pathToFileURL(modulePath).href) as { createEnvironment?: EnvironmentFactory };
  if (typeof loaded.createEnvironment !== 'function') {
    throw new TypeError('environment module must export createEnvironment({ seed })');
  }
  const environment = await loaded.createEnvironment({ seed: seedOption(args.options.get('seed')) });
  if (!environment || typeof environment.reset !== 'function' || typeof environment.step !== 'function') {
    throw new TypeError('createEnvironment did not return an AgentEnvironment-compatible object');
  }
  const driver = createKeyedAgentDriver<TickView<unknown, unknown>>(provider.id, {
    apiKey,
    model: args.options.get('model'),
  });
  const result = await runAgentDriverEpisode(environment, driver, {
    systemPrompt: args.options.get('prompt'),
    onDecision: (decision) => io.stderr(`${JSON.stringify(decision.action)}\n`),
  });
  io.stdout(`${JSON.stringify(result.transcript, null, 2)}\n`);
  return result.finalStep.info.terminationReason === 'won' ? 0 : 1;
}

/** Programmatic entry point used by the `gaos-agent` executable. */
export async function runAgentCli(argv: readonly string[], io: AgentCliIO = defaultIo()): Promise<number> {
  const [command = 'help', ...rest] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    io.stdout(HELP);
    return 0;
  }
  const args = parseArguments(rest);
  if (command === 'drivers') return listDrivers(io);
  if (command === 'status') return status(args, io);
  if (command === 'check') return check(args, io);
  if (command === 'spawn') return spawnAgent(args, io);
  if (command === 'run') return runKeyed(args, io);
  throw new TypeError(`unknown command: ${command}`);
}

export { HELP as AGENT_CLI_HELP };
