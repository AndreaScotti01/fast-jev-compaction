import { describe, expect, it } from 'vitest';
import { errorRecord, parseRecord, recordOf, type CompactionRecord } from '../src/stats-record.js';
import { buildReport, openStats, recordCompaction, statsDbPath } from '../src/stats.js';
import type { CompactResult } from '../src/types.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 29, 12, 0);

function record(overrides: Partial<CompactionRecord> = {}): CompactionRecord {
  return {
    status: 'applied',
    messagesBefore: 20,
    messagesAfter: 14,
    tokensBefore: 1000,
    tokensAfter: 600,
    stateTokens: 700,
    layaStateTokens: 720,
    stateTruncated: false,
    requests: 1,
    reduction: 0.4,
    decisions: [
      { tool: 'Read', action: 'drop_call', reason: 'call_dropped', keepCall: 0.1, keepResult: 0.1, tokensKept: 0, tokensDropped: 300 },
      { tool: 'Bash', action: 'drop_result', reason: 'result_dropped', keepCall: 0.9, keepResult: 0.1, tokensKept: 40, tokensDropped: 100 },
      { tool: 'Read', action: 'keep', reason: 'kept', keepCall: 0.9, keepResult: 0.9, tokensKept: 200, tokensDropped: 0 },
      { tool: 'Bash', action: 'keep', reason: 'pinned', keepCall: 1, keepResult: 1, tokensKept: 50, tokensDropped: 0 },
    ],
    ...overrides,
  };
}

describe('stats database', () => {
  it('reports that nothing was recorded on an empty database', () => {
    const db = openStats(':memory:');
    expect(buildReport(db, { now: NOW })).toContain('no compactions recorded yet');
  });

  it('totals tokens seen, let through and dropped, per tool and overall', () => {
    const db = openStats(':memory:');
    recordCompaction(db, record(), NOW - DAY);
    recordCompaction(db, record({ tokensBefore: 500, tokensAfter: 400 }), NOW - 2 * DAY);
    const report = buildReport(db, { now: NOW });
    expect(report).toContain('Compactions: 2 (2 applied, 0 fell back');
    expect(report).toContain('1,500 seen -> 1,000 let through (67%), 500 dropped (33%)');
    const read = report.split('\n').find((line) => line.startsWith('Read'))!;
    expect(read.split(/\s+/)).toEqual(['Read', '4', '2', '0', '400', '600', '60%']);
    const bash = report.split('\n').find((line) => line.startsWith('Bash'))!;
    expect(bash.split(/\s+/)).toEqual(['Bash', '4', '0', '2', '180', '200', '53%']);
  });

  it('counts fallbacks and failures but only totals tokens of applied compactions', () => {
    const db = openStats(':memory:');
    recordCompaction(db, record(), NOW);
    recordCompaction(db, record({ status: 'below_threshold', tokensBefore: 9000, tokensAfter: 8500 }), NOW);
    recordCompaction(db, errorRecord(30, 'Laya request failed (500): boom'), NOW);
    const report = buildReport(db, { now: NOW });
    expect(report).toContain('Compactions: 3 (1 applied, 1 fell back to the built-in summary, 1 failed)');
    expect(report).toContain('1,000 seen -> 600 let through');
    expect(report).toContain('failed: Laya request failed (500): boom');
  });

  it('limits the report to the requested number of days', () => {
    const db = openStats(':memory:');
    recordCompaction(db, record(), NOW - 10 * DAY);
    recordCompaction(db, record({ tokensBefore: 200, tokensAfter: 100 }), NOW - DAY);
    const week = buildReport(db, { days: 7, now: NOW });
    expect(week).toContain('last 7 days');
    expect(week).toContain('Compactions: 1 (1 applied');
    expect(week).toContain('200 seen -> 100 let through');
    expect(buildReport(db, { now: NOW })).toContain('Compactions: 2');
    expect(buildReport(db, { days: 1, now: NOW })).toContain('last 1 day;');
  });

  it('warns when Laya had to cut off the state', () => {
    const db = openStats(':memory:');
    recordCompaction(db, record({ stateTruncated: true }), NOW);
    expect(buildReport(db, { now: NOW })).toContain('cut off part of the state');
  });

  it('rolls a failed insert back completely', () => {
    const db = openStats(':memory:');
    const bad = record({ decisions: [{ ...record().decisions[0]!, tool: null as unknown as string }] });
    expect(() => recordCompaction(db, bad, NOW)).toThrow();
    expect(buildReport(db, { now: NOW })).toContain('no compactions recorded yet');
  });

  it('resolves the database path from the environment', () => {
    expect(statsDbPath({ LAYA_STATS_DB: '/tmp/x.db' })).toBe('/tmp/x.db');
    expect(statsDbPath({ CLAUDE_CONFIG_DIR: '/cfg' }).replaceAll('\\', '/')).toBe(
      '/cfg/plugins/data/laya-compaction/stats.db',
    );
  });
});

describe('record parsing', () => {
  it('round-trips a record through JSON', () => {
    expect(parseRecord(JSON.stringify(record()))).toEqual(record());
  });

  it('rejects malformed input before it reaches the database', () => {
    expect(() => parseRecord('nope')).toThrow();
    expect(() => parseRecord('{"status":"applied"}')).toThrow(/decisions/);
    expect(() => parseRecord(JSON.stringify({ ...record(), status: 'weird' }))).toThrow(/status/);
    expect(() => parseRecord(JSON.stringify({ ...record(), tokensBefore: 'x' }))).toThrow(/tokensBefore/);
    expect(() =>
      parseRecord(JSON.stringify({ ...record(), decisions: [{ tool: 'Read', action: 'explode' }] })),
    ).toThrow(/action/);
  });

  it('builds a record from a compaction result', () => {
    const result = {
      messages: [],
      decisions: [
        { id: 't1', tool: 'Read', action: 'drop_call', reason: 'call_dropped', keepCall: 0.1, keepResult: 0.1, tokensKept: 0, tokensDropped: 50 },
      ],
      stats: {
        messagesBefore: 4, messagesAfter: 3, charsBefore: 1, charsAfter: 1, tokensBefore: 100, tokensAfter: 50,
        layaStateTokens: 80, stateTruncated: false, calls: 1, kept: 0, resultsDropped: 0, callsDropped: 1,
        pinned: 0, stateTokens: 70, stateStage: 'full', requests: 1, ms: 5,
      },
    } as CompactResult;
    const built = recordOf(result, 'applied', 0.5);
    expect(built).toMatchObject({ status: 'applied', tokensBefore: 100, tokensAfter: 50, reduction: 0.5, requests: 1 });
    expect(built.decisions[0]).toEqual({
      tool: 'Read', action: 'drop_call', reason: 'call_dropped', keepCall: 0.1, keepResult: 0.1, tokensKept: 0, tokensDropped: 50,
    });
    expect(errorRecord(7, 'x'.repeat(900)).error).toHaveLength(500);
    expect(parseRecord(JSON.stringify(errorRecord(7, 'down'))).status).toBe('error');
  });
});
