import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { errorRecord, recordOf, type CompactionRecord } from '../src/stats-record.js';
import { buildLayaRequest, DEFAULT_MODEL, layaServerUrl, parseLayaResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  LayaAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

/** The shape of `$.clock.sleep`. */
export type HookSleep = (ms: number, options?: { signal?: AbortSignal }) => Promise<void>;

export const REQUEST_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 5_000;

/** `$.http.fetch` has no timeout of its own; a server that is off must not hang `/compact`. */
async function withTimeout<T>(work: Promise<T>, sleep: HookSleep, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = sleep(ms, { signal: controller.signal }).then((): never => {
    throw new Error(`laya-serve did not answer within ${Math.round(ms / 1000)}s`);
  });
  timer.catch(() => undefined);
  try {
    return await Promise.race([work, timer]);
  } finally {
    controller.abort();
  }
}

export type HookConfig = CompactOptions & {
  apiKey?: string;
  baseUrl: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    baseUrl: optionString(options, 'baseUrl') ?? '',
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `LayaAsker` over the engine's `$.http.fetch`. */
export function layaAsker(
  fetchFn: HookFetch,
  connection: { apiKey?: string; model: string; baseUrl: string },
  sleep?: HookSleep,
): LayaAsker {
  return {
    async ask(state, questions) {
      const request = buildLayaRequest(connection, state, questions);
      const pending = fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      const response = sleep ? await withTimeout(pending, sleep, REQUEST_TIMEOUT_MS) : await pending;
      return parseLayaResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the server fails or the history cannot be fitted. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  sleep?: HookSleep,
): Promise<SessionCompaction> {
  const result = await compact(messages, layaAsker(fetchFn, config, sleep), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('LAYA_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['LAYA_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** The shape of `$.process.run`. */
export type HookRun = (
  argv: readonly string[],
  init?: { stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const STATS_HELPER_TIMEOUT_MS = 10_000;
const STATS_ARGUMENT = /^(all|\d+d?)$/i;

/** Runs `dist/stats-cli.js` (node:sqlite lives outside the hook sandbox) and returns its stdout. */
export async function runStatsCli(
  run: HookRun,
  pluginRoot: string,
  args: readonly string[],
  stdin?: string,
): Promise<string> {
  const result = await run(
    ['node', '--no-warnings', `${pluginRoot}/dist/stats-cli.js`, ...args],
    { ...(stdin === undefined ? {} : { stdin }), timeoutMs: STATS_HELPER_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `stats helper exited with ${result.exitCode}`);
  }
  return result.stdout;
}

/** Stores one compaction in the stats database; a failure is logged and never reaches compaction. */
export async function saveStats(
  run: HookRun,
  pluginRoot: string,
  record: CompactionRecord,
  log: (text: string) => void,
): Promise<void> {
  try {
    await runStatsCli(run, pluginRoot, ['record'], JSON.stringify(record));
  } catch (error) {
    log(`stats not recorded (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** The text of `/laya-stats [days|all]`. */
export async function statsReport(run: HookRun, pluginRoot: string, args: string): Promise<string> {
  const argument = args.trim() === '' ? 'all' : args.trim();
  if (!STATS_ARGUMENT.test(argument)) {
    return 'Usage: /laya-stats [days|all]   e.g. /laya-stats 7';
  }
  try {
    return (await runStatsCli(run, pluginRoot, ['report', argument.replace(/d$/i, '')])).trimEnd();
  } catch (error) {
    return `Stats unavailable: ${error instanceof Error ? error.message : String(error)}
They need Node.js 22.13+ on PATH and "npm run build" in the plugin folder.`;
  }
}

/** `config.set` for the server URL row: normalizes a valid address, denies anything else. */
export function validateServerUrl(value: unknown): { value: string } | { deny: string } {
  if (typeof value !== 'string') return { deny: 'the Laya server URL must be text' };
  try {
    return { value: layaServerUrl(value) };
  } catch (error) {
    return { deny: error instanceof Error ? error.message : String(error) };
  }
}

/** What a Laya `/health` body says: the loaded models and the device, else the raw text. */
export function healthSummary(text: string): string {
  try {
    const health = JSON.parse(text) as { loaded?: unknown; device?: unknown };
    if (Array.isArray(health.loaded) && typeof health.device === 'string') {
      return `models ${health.loaded.join(', ') || 'none'} on ${health.device}`;
    }
  } catch {
    // not JSON: show it as is
  }
  return text.slice(0, 300);
}

/** The `/laya-status` report: the configured server, whether it answers `/health`, and how fast. */
export async function layaStatus(
  config: Pick<HookConfig, 'baseUrl' | 'apiKey'>,
  fetchFn: HookFetch,
  sleep: HookSleep,
  now: () => Promise<number>,
): Promise<string> {
  const hint = 'Change it under /config → Laya server URL.';
  let server: string;
  try {
    server = layaServerUrl(config.baseUrl);
  } catch (error) {
    return `Laya server URL is invalid: ${error instanceof Error ? error.message : String(error)}
${hint}`;
  }
  const started = await now();
  try {
    const response = await withTimeout(
      fetchFn(`${server}/health`, {
        method: 'GET',
        headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      }),
      sleep,
      STATUS_TIMEOUT_MS,
    );
    const ms = (await now()) - started;
    if (!response.ok) {
      return `${server} answered HTTP ${response.status} after ${ms} ms: ${response.text.slice(0, 200)}
${hint}`;
    }
    return `${server} is up (${ms} ms): ${healthSummary(response.text)}
${hint}`;
  } catch (error) {
    return `${server} is unreachable: ${error instanceof Error ? error.message : String(error)}
Is docker compose running on that machine, and is port 8000 open in its firewall? ${hint}`;
  }
}

const SERVER_URL_ROW = /^laya-compaction(@[^.]*)?\.baseUrl$/;

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const { result, messages } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        $.clock.sleep,
      );
      for (const line of decisionLogLines(result)) $.ui.log(line);
      const ratio = reductionRatio(result);
      if (ratio < config.minReductionRatio) {
        await saveStats($.process.run, $.plugin.root, recordOf(result, 'below_threshold', ratio), $.ui.log);
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      await saveStats($.process.run, $.plugin.root, recordOf(result, 'applied', ratio), $.ui.log);
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await saveStats($.process.run, $.plugin.root, errorRecord(event.messages.length, reason), $.ui.log);
      notify($, `fallback to built-in summary (${reason})`);
      return next(event);
    }
  });

  on('session.start', async ($, event, next) => {
    try {
      await $.command.register({
        name: 'laya-status',
        description: 'Check that the Laya server answers',
      });
      await $.command.register({
        name: 'laya-stats',
        description: 'Show how many tokens compaction let through and dropped',
        argumentHint: '[days|all]',
      });
    } catch (error) {
      $.ui.log(`slash commands not registered (${error instanceof Error ? error.message : String(error)})`);
    }
    return next(event);
  });

  on('command.run', { command: 'laya-status' }, async ($, event, next) => {
    const config = { ...configured, apiKey: await getApiKey($, configured) };
    const text = await layaStatus(
      config,
      async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      },
      $.clock.sleep,
      $.clock.now,
    );
    return { ...(await next(event)), text };
  });

  on('command.run', { command: 'laya-stats' }, async ($, event, next) => {
    const text = await statsReport($.process.run, $.plugin.root, event.args);
    return { ...(await next(event)), text };
  });

  on('config.set', ($, event, next) => {
    if (!SERVER_URL_ROW.test(event.key)) return next(event);
    const checked = validateServerUrl(event.value);
    return 'deny' in checked ? { deny: checked.deny } : next({ ...event, value: checked.value });
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
