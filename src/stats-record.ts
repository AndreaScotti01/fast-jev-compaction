import type { CompactResult } from './types.js';

export type CompactionStatus = 'applied' | 'below_threshold' | 'error';

export interface DecisionRecord {
  tool: string;
  action: 'keep' | 'drop_result' | 'drop_call';
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped';
  keepCall: number;
  keepResult: number;
  tokensKept: number;
  tokensDropped: number;
}

/** One compaction as the stats DB stores it; plain JSON so it can cross a process boundary. */
export interface CompactionRecord {
  status: CompactionStatus;
  error?: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  stateTokens: number;
  layaStateTokens: number;
  stateTruncated: boolean;
  requests: number;
  reduction: number;
  decisions: DecisionRecord[];
}

/** A compaction that produced a result; `applied` says whether the pruned history replaced the built-in summary. */
export function recordOf(
  result: CompactResult,
  status: 'applied' | 'below_threshold',
  reduction: number,
): CompactionRecord {
  const { stats } = result;
  return {
    status,
    messagesBefore: stats.messagesBefore,
    messagesAfter: stats.messagesAfter,
    tokensBefore: stats.tokensBefore,
    tokensAfter: stats.tokensAfter,
    stateTokens: stats.stateTokens,
    layaStateTokens: stats.layaStateTokens,
    stateTruncated: stats.stateTruncated,
    requests: stats.requests,
    reduction,
    decisions: result.decisions.map((d) => ({
      tool: d.tool,
      action: d.action,
      reason: d.reason,
      keepCall: d.keepCall,
      keepResult: d.keepResult,
      tokensKept: d.tokensKept,
      tokensDropped: d.tokensDropped,
    })),
  };
}

/** A compaction that failed before producing anything (server down, history too large, ...). */
export function errorRecord(messages: number, error: string): CompactionRecord {
  return {
    status: 'error',
    error: error.slice(0, 500),
    messagesBefore: messages,
    messagesAfter: messages,
    tokensBefore: 0,
    tokensAfter: 0,
    stateTokens: 0,
    layaStateTokens: 0,
    stateTruncated: false,
    requests: 0,
    reduction: 0,
    decisions: [],
  };
}

const STATUSES: readonly string[] = ['applied', 'below_threshold', 'error'];
const ACTIONS: readonly string[] = ['keep', 'drop_result', 'drop_call'];

function num(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid record: ${name} is not a number`);
  }
  return value;
}

/** Validates JSON received on stdin before it reaches the database. */
export function parseRecord(json: string): CompactionRecord {
  const raw: unknown = JSON.parse(json);
  if (raw === null || typeof raw !== 'object') throw new Error('invalid record: not an object');
  const r = raw as Record<string, unknown>;
  if (typeof r['status'] !== 'string' || !STATUSES.includes(r['status'])) {
    throw new Error('invalid record: bad status');
  }
  if (!Array.isArray(r['decisions'])) throw new Error('invalid record: decisions is not a list');
  const decisions = r['decisions'].map((item: unknown, index): DecisionRecord => {
    const d = (item ?? {}) as Record<string, unknown>;
    if (typeof d['tool'] !== 'string') throw new Error(`invalid record: decision ${index} has no tool`);
    if (typeof d['action'] !== 'string' || !ACTIONS.includes(d['action'])) {
      throw new Error(`invalid record: decision ${index} has a bad action`);
    }
    return {
      tool: d['tool'],
      action: d['action'] as DecisionRecord['action'],
      reason: String(d['reason']) as DecisionRecord['reason'],
      keepCall: num(d['keepCall'], 'keepCall'),
      keepResult: num(d['keepResult'], 'keepResult'),
      tokensKept: num(d['tokensKept'], 'tokensKept'),
      tokensDropped: num(d['tokensDropped'], 'tokensDropped'),
    };
  });
  return {
    status: r['status'] as CompactionStatus,
    ...(typeof r['error'] === 'string' ? { error: r['error'] } : {}),
    messagesBefore: num(r['messagesBefore'], 'messagesBefore'),
    messagesAfter: num(r['messagesAfter'], 'messagesAfter'),
    tokensBefore: num(r['tokensBefore'], 'tokensBefore'),
    tokensAfter: num(r['tokensAfter'], 'tokensAfter'),
    stateTokens: num(r['stateTokens'], 'stateTokens'),
    layaStateTokens: num(r['layaStateTokens'], 'layaStateTokens'),
    stateTruncated: r['stateTruncated'] === true,
    requests: num(r['requests'], 'requests'),
    reduction: num(r['reduction'], 'reduction'),
    decisions,
  };
}
