import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CliAgentRegistry,
  createBuiltinCliAgents,
  createDefaultCliAgentRegistry,
  customCliAgentsFromJson,
  inspectCliAgent,
  parseCodexJson,
  parseGenericLine,
  parseStreamJson,
  resolveCliExecutable,
  runAgentCli,
  spawnCliAgent,
  type CliAgentSpec,
} from '../src/agent-cli/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CLI agent recipes', () => {
  it('ships six extensible built-in recipes', () => {
    const agents = createBuiltinCliAgents();
    expect(agents.map(({ id }) => id)).toEqual(['claude', 'ollama', 'codex', 'cursor', 'grok', 'opencode']);
    const registry = new CliAgentRegistry(agents);
    expect(registry.require('codex').bin).toBe('codex');
    expect(() => registry.register(agents[0]!)).toThrow('already registered');
  });

  it('configures a caller-owned MCP server and tool allowlist', () => {
    const registry = createDefaultCliAgentRegistry();
    const context = {
      mcpUrl: 'http://127.0.0.1:9000/mcp',
      prompt: 'Complete the episode.',
      serverName: 'arena',
      toolNames: ['observe', 'act', 'say'],
    };
    const claude = registry.require('claude').launch(context);
    expect(claude.argv).toContain('mcp__arena__observe,mcp__arena__act,mcp__arena__say');
    expect(claude.argv.join(' ')).toContain('http://127.0.0.1:9000/mcp');

    const ollama = createDefaultCliAgentRegistry({ ollamaModel: 'local-test-model' })
      .require('ollama')
      .launch(context);
    expect(ollama.argv.slice(0, 7)).toEqual([
      'launch', 'claude', '--model', 'local-test-model', '--yes', '--', '-p',
    ]);
    expect(ollama.argv).toContain('mcp__arena__observe,mcp__arena__act,mcp__arena__say');
    expect(ollama.argv).not.toContain('claude-opus-4-8');

    const codex = registry.require('codex').launch(context);
    expect(codex.argv).toContain('mcp_servers.arena.url="http://127.0.0.1:9000/mcp"');

    const cursor = registry.require('cursor').launch(context);
    expect(JSON.parse(cursor.files['.cursor/mcp.json']!)).toEqual({
      mcpServers: { arena: { url: context.mcpUrl } },
    });

    const grok = registry.require('grok').launch(context);
    expect(grok.files['.grok/config.toml']).toContain('[mcp_servers.arena]');

    const opencode = registry.require('opencode').launch(context);
    expect(JSON.parse(opencode.files['opencode.json']!).mcp.arena.url).toBe(context.mcpUrl);
  });

  it('loads declarative custom recipes with safe placeholders', () => {
    const [custom] = customCliAgentsFromJson(JSON.stringify({
      local: {
        bin: 'local-agent',
        args: ['--server', '{mcpUrl}', '--prompt', '{prompt}', '--tools', '{allowedTools}'],
        files: { 'agent.json': '{"server":"{serverName}"}' },
      },
    }));
    expect(custom?.launch({
      mcpUrl: 'http://localhost/mcp',
      prompt: 'play',
      toolNames: ['observe'],
    })).toEqual({
      argv: ['--server', 'http://localhost/mcp', '--prompt', 'play', '--tools', 'mcp__game__observe'],
      files: { 'agent.json': '{"server":"game"}' },
    });
  });

  it('starts and resumes a Claude conversation with the same session id', () => {
    const registry = createDefaultCliAgentRegistry();
    const spec = registry.require('claude');
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const initial = spec.launch({ mcpUrl: 'http://localhost/mcp', prompt: 'play', sessionId });
    const resumed = spec.launch({
      mcpUrl: 'http://localhost/mcp',
      prompt: 'coach interrupted; continue',
      sessionId,
      resume: true,
    });
    expect(spec.supportsResume).toBe(true);
    expect(initial.argv).toContain('--session-id');
    expect(initial.argv).toContain(sessionId);
    expect(resumed.argv).toContain('--resume');
    expect(resumed.argv).toContain(sessionId);
    expect(resumed.argv).not.toContain('--session-id');
  });

  it('parses transcript formats without surfacing unrelated JSON', () => {
    expect(parseStreamJson(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'consider move' }] },
    }))).toEqual(['consider move']);
    expect(parseCodexJson(JSON.stringify({ item: { item_type: 'agent_reasoning', text: 'choose jump' } })))
      .toEqual(['choose jump']);
    expect(parseGenericLine('{"text":"hello"}')).toEqual(['hello']);
    expect(parseGenericLine('plain output')).toEqual(['plain output']);
  });
});

describe('CLI agent process integration', () => {
  it('resolves executables and reports missing agents without a model call', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gaos-agent-test-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'working-agent');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    expect(resolveCliExecutable('working-agent', directory)).toBe(executable);

    const status = await inspectCliAgent({
      id: 'missing',
      label: 'Missing',
      bin: 'definitely-missing-agent',
      launch: () => ({ argv: [], files: {} }),
      login: 'Install it.',
    }, { path: directory });
    expect(status).toMatchObject({ installed: false, auth: 'none' });
  });

  it('launches in a scratch directory and streams parsed transcript text', async () => {
    const transcripts: string[] = [];
    const spec: CliAgentSpec = {
      id: 'node-test',
      label: 'Node test',
      bin: process.execPath,
      launch: () => ({
        argv: ['-e', 'console.log(JSON.stringify({text:"move selected"}))'],
        files: { 'config/agent.json': '{}' },
      }),
      parseLine: parseGenericLine,
      login: 'none',
    };
    const launched = spawnCliAgent(spec, { mcpUrl: 'http://localhost/mcp', prompt: 'play' }, {
      onTranscript: (text) => transcripts.push(text),
    });
    await expect(launched.completion).resolves.toMatchObject({ code: 0, signal: null });
    expect(transcripts).toEqual(['move selected']);
  });

  it('interrupts and resumes a capable CLI through the generic process contract', async () => {
    const transcripts: string[] = [];
    let transportReset = false;
    const spec: CliAgentSpec = {
      id: 'resumable-test', label: 'Resumable test', bin: process.execPath,
      supportsResume: true,
      launch: (context) => ({
        argv: context.resume
          ? ['-e', 'console.log(JSON.stringify({text:"resumed"}))']
          : ['-e', 'setInterval(() => {}, 1000)'],
        files: {},
      }),
      parseLine: parseGenericLine,
      login: 'none',
    };
    const launched = spawnCliAgent(spec, {
      mcpUrl: 'http://localhost/mcp', prompt: 'play',
      sessionId: '00000000-0000-4000-8000-000000000001',
    }, { onTranscript: (text) => transcripts.push(text) });
    const result = await launched.interrupt({
      prompt: 'new guidance',
      beforeResume: () => { transportReset = true; },
    });
    expect(result).toMatchObject({ mode: 'resume', interrupted: true, preservesContext: true });
    expect(transportReset).toBe(true);
    await expect(result.process?.completion).resolves.toMatchObject({ code: 0 });
    expect(transcripts).toEqual(['resumed']);
  });

  it('rejects custom config paths that escape the scratch directory', () => {
    const spec: CliAgentSpec = {
      id: 'unsafe',
      label: 'Unsafe',
      bin: process.execPath,
      launch: () => ({ argv: [], files: { '../outside': 'no' } }),
      login: 'none',
    };
    expect(() => spawnCliAgent(spec, { mcpUrl: 'http://localhost/mcp', prompt: 'play' }))
      .toThrow('escapes scratch directory');
  });
});

describe('gaos-agent command', () => {
  const invoke = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await runAgentCli(argv, {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      env,
      cwd: process.cwd(),
    });
    return { code, stdout, stderr };
  };

  it('lists keyed and external CLI drivers as machine-readable JSON', async () => {
    const result = await invoke(['drivers']);
    expect(result.code).toBe(0);
    const drivers = JSON.parse(result.stdout) as Array<{ id: string; type: string }>;
    expect(drivers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex', type: 'cli' }),
      expect.objectContaining({ id: 'key:openai', type: 'keyed' }),
    ]));
  });

  it('reports a missing keyed-provider environment variable without making a request', async () => {
    const result = await invoke(['check', 'openai']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      provider: 'openai',
      ok: false,
      detail: 'missing OPENAI_API_KEY',
    });
    expect(result.stderr).toContain('platform.openai.com/api-keys');
  });

  it('refuses command-line API keys and validates required options', async () => {
    await expect(invoke(['run', 'openai', '--api-key', 'should-not-be-accepted'], {
      OPENAI_API_KEY: 'present',
    })).rejects.toThrow('unknown option --api-key');
  });

  it('runs a keyed driver against an environment module end to end', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gaos-agent-module-'));
    temporaryDirectories.push(directory);
    const modulePath = join(directory, 'environment.mjs');
    writeFileSync(modulePath, `
export function createEnvironment({ seed }) {
  let done = false;
  const step = () => ({
    observation: { actions: [{ id: 'finish', params: 'none' }], status: done ? 'won' : 'playing', hud: { actionsUsed: done ? 1 : 0 } },
    actionDefinitions: [{ id: 'finish', params: 'none' }],
    legalActions: done ? [] : [{ id: 'finish' }],
    reward: done ? 1 : 0,
    terminated: done,
    truncated: false,
    done,
    info: { seed: seed ?? 1, ticks: done ? 1 : 0, totalReward: done ? 1 : 0, status: done ? 'won' : 'playing', stars: done ? 1 : null, actionsUsed: done ? 1 : 0, terminationReason: done ? 'won' : null },
  });
  return {
    reset() { done = false; return step(); },
    step() { done = true; return step(); },
    transcript() { return { version: '1.0', level: { id: 'test' }, seed: seed ?? 1, actions: [{ n: 1, action: { id: 'finish' }, reward: 1, status: 'won', actionsUsed: 1 }], result: step().info }; },
  };
}
`);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":{"id":"finish"}}' } }],
    }), { status: 200 }));
    const result = await invoke([
      'run', 'openai', '--module', modulePath, '--model', 'offline-test', '--seed', '9',
    ], { OPENAI_API_KEY: 'test-only' });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ seed: 9, result: { terminationReason: 'won' } });
    expect(result.stderr).toContain('{"id":"finish"}');
  });
});
