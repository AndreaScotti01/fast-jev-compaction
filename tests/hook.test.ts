import { describe, expect, it } from 'vitest';
import {
  healthSummary,
  layaStatus,
  compactSession,
  decisionLog,
  decisionLogLines,
  resolveHookConfig,
  saveStats,
  statsReport,
  summarize,
  toSessionMessages,
  validateServerUrl,
} from '../hooks/laya.ts';
import { applyDecisions, decideCall } from '../src/compact.js';
import { buildLayaRequest, layaServerUrl } from '../src/request.js';
import { collectToolCalls } from '../src/state.js';
import { errorRecord } from '../src/stats-record.js';
import type { Message } from '../src/types.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function layaFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      model: 'multilingual',
      baseUrl: '',
    });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'laya-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'laya-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      baseUrl: '',
    });
  });

  it('reads a custom endpoint', () => {
    expect(resolveHookConfig({ baseUrl: 'http://gpu-box:8000/v1/systemone' }).baseUrl).toBe(
      'http://gpu-box:8000/v1/systemone',
    );
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[laya-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[laya-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, baseUrl: 'http://pc:8000' }), apiKey: 'k', model: 'laya-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      layaFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('laya-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, baseUrl: 'http://pc:8000' }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, layaFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1, baseUrl: 'http://pc:8000' });
    await expect(
      compactSession(transcript(), config, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('server URL', () => {
  it('validates and normalizes what /config takes', () => {
    expect(validateServerUrl(' http://192.168.1.50:8000/ ')).toEqual({ value: 'http://192.168.1.50:8000' });
    expect(validateServerUrl('http://pc.local:8000/v1/systemone')).toEqual({ value: 'http://pc.local:8000' });
    expect(validateServerUrl('192.168.1.50:8000')).toHaveProperty('deny');
    expect(validateServerUrl('ftp://pc:8000')).toHaveProperty('deny');
    expect(validateServerUrl('http://pc:8000/other')).toHaveProperty('deny');
    expect(validateServerUrl(42)).toHaveProperty('deny');
  });

  it('accepts a bare address in the config and posts to /v1/systemone', () => {
    expect(layaServerUrl('http://gpu-box:8000')).toBe('http://gpu-box:8000');
    const request = buildLayaRequest({ baseUrl: 'http://gpu-box:8000/' }, 's', {});
    expect(request.url).toBe('http://gpu-box:8000/v1/systemone');
  });
});

describe('timeouts and /laya-status', () => {
  const never = () => new Promise<never>(() => undefined);
  const instant = async () => undefined;

  it('gives up on a server that never answers so the hook can fall back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1, baseUrl: 'http://pc:8000' });
    await expect(compactSession(transcript(), config, never, instant)).rejects.toThrow(/did not answer within 30s/);
  });

  it('reports a reachable server with its latency', async () => {
    let clock = 1000;
    const text = await layaStatus(
      { baseUrl: 'http://pc:8000/' },
      async (url) => {
        expect(url).toBe('http://pc:8000/health');
        clock += 42;
        return { status: 200, ok: true, text: '{"status":"ok"}' };
      },
      never,
      async () => clock,
    );
    expect(text).toContain('http://pc:8000 is up (42 ms)');
    expect(text).toContain('/config');
  });

  it('reports an unreachable server and an invalid address', async () => {
    const down = await layaStatus({ baseUrl: 'http://pc:8000' }, never, instant, async () => 0);
    expect(down).toContain('unreachable');
    expect(down).toContain('firewall');
    const bad = await layaStatus({ baseUrl: 'nope' }, never, instant, async () => 0);
    expect(bad).toContain('invalid');
  });
});

describe('stats helper', () => {
  const ok = (stdout = '') => async () => ({ exitCode: 0, stdout, stderr: '' });

  it('pipes a record to the helper as JSON on stdin', async () => {
    const calls: { argv: readonly string[]; stdin?: string }[] = [];
    const record = errorRecord(3, 'down');
    await saveStats(
      async (argv, init) => {
        calls.push({ argv, ...(init?.stdin === undefined ? {} : { stdin: init.stdin }) });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      '/plugins/laya',
      record,
      () => undefined,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(['node', '--no-warnings', '/plugins/laya/dist/stats-cli.js', 'record']);
    expect(JSON.parse(calls[0]!.stdin!)).toEqual(record);
  });

  it('logs instead of throwing when the helper fails or node is missing', async () => {
    const logs: string[] = [];
    await saveStats(async () => ({ exitCode: 1, stdout: '', stderr: 'boom\n' }), '/p', errorRecord(1, 'x'), (t) => logs.push(t));
    await saveStats(async () => { throw new Error('spawn node ENOENT'); }, '/p', errorRecord(1, 'x'), (t) => logs.push(t));
    expect(logs).toEqual(['stats not recorded (boom)', 'stats not recorded (spawn node ENOENT)']);
  });

  it('turns /laya-stats arguments into a report request', async () => {
    const seen: string[][] = [];
    const run = async (argv: readonly string[]) => {
      seen.push([...argv].slice(3));
      return { exitCode: 0, stdout: 'REPORT\n', stderr: '' };
    };
    expect(await statsReport(run, '/p', '')).toBe('REPORT');
    expect(await statsReport(run, '/p', ' 7 ')).toBe('REPORT');
    expect(await statsReport(run, '/p', '30d')).toBe('REPORT');
    expect(await statsReport(run, '/p', 'ALL')).toBe('REPORT');
    expect(seen).toEqual([['report', 'all'], ['report', '7'], ['report', '30'], ['report', 'ALL']]);
    expect(await statsReport(run, '/p', '7; rm -rf /')).toMatch(/^Usage:/);
    expect(seen).toHaveLength(4);
  });

  it('explains what is missing when the helper cannot run', async () => {
    const text = await statsReport(async () => { throw new Error('spawn node ENOENT'); }, '/p', '');
    expect(text).toContain('Stats unavailable: spawn node ENOENT');
    expect(text).toContain('Node.js 22.13+');
    expect(await statsReport(ok('x'), '/p', '')).toBe('x');
  });

  it('summarises Laya health', () => {
    expect(healthSummary('{"status":"ok","loaded":["multilingual"],"device":"cuda"}')).toBe('models multilingual on cuda');
    expect(healthSummary('{"status":"ok"}')).toBe('{"status":"ok"}');
    expect(healthSummary('plain text')).toBe('plain text');
  });
});
