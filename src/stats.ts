import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync as Database } from 'node:sqlite';

import type { CompactionRecord } from './stats-record.js';

// Vite does not know node:sqlite as a builtin yet, so load it at runtime instead of importing it.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = Database;

const SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;

/** `$LAYA_STATS_DB`, else the plugin data folder under Claude Code's config directory. */
export function statsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env['LAYA_STATS_DB']) return env['LAYA_STATS_DB'];
  const configDir = env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
  return join(configDir, 'plugins', 'data', 'laya-compaction', 'stats.db');
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version >= SCHEMA_VERSION) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS compactions (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      messages_before INTEGER NOT NULL,
      messages_after INTEGER NOT NULL,
      tokens_before INTEGER NOT NULL,
      tokens_after INTEGER NOT NULL,
      state_tokens INTEGER NOT NULL,
      laya_state_tokens INTEGER NOT NULL,
      state_truncated INTEGER NOT NULL,
      requests INTEGER NOT NULL,
      reduction REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS compactions_ts ON compactions (ts);
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY,
      compaction_id INTEGER NOT NULL REFERENCES compactions (id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      keep_call REAL NOT NULL,
      keep_result REAL NOT NULL,
      tokens_kept INTEGER NOT NULL,
      tokens_dropped INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS decisions_compaction ON decisions (compaction_id);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

/** Opens (creating it and its folder if needed) the stats database; `:memory:` works for tests. */
export function openStats(path: string = statsDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

export function recordCompaction(
  db: DatabaseSync,
  record: CompactionRecord,
  now: number = Date.now(),
): number {
  db.exec('BEGIN');
  try {
    const inserted = db
      .prepare(
        `INSERT INTO compactions (ts, status, error, messages_before, messages_after, tokens_before,
           tokens_after, state_tokens, laya_state_tokens, state_truncated, requests, reduction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        record.status,
        record.error ?? null,
        record.messagesBefore,
        record.messagesAfter,
        record.tokensBefore,
        record.tokensAfter,
        record.stateTokens,
        record.layaStateTokens,
        record.stateTruncated ? 1 : 0,
        record.requests,
        record.reduction,
      );
    const id = Number(inserted.lastInsertRowid);
    const insertDecision = db.prepare(
      `INSERT INTO decisions (compaction_id, tool, action, reason, keep_call, keep_result, tokens_kept, tokens_dropped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const d of record.decisions) {
      insertDecision.run(id, d.tool, d.action, d.reason, d.keepCall, d.keepResult, d.tokensKept, d.tokensDropped);
    }
    db.exec('COMMIT');
    return id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const n = (value: number): string => Math.round(value).toLocaleString('en-US');
const pct = (part: number, whole: number): string =>
  whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;

interface Totals {
  total: number;
  applied: number;
  below: number;
  errors: number;
  truncated: number;
  tokens_before: number | null;
  tokens_after: number | null;
}

/** The text `/laya-stats` shows. `days` limits it to that many days back; omitted means all time. */
export function buildReport(
  db: DatabaseSync,
  options: { days?: number; now?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const since = options.days === undefined ? 0 : now - options.days * DAY_MS;
  const scope = options.days === undefined ? 'all time' : `last ${options.days} day${options.days === 1 ? '' : 's'}`;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'applied'), 0) AS applied,
              COALESCE(SUM(status = 'below_threshold'), 0) AS below,
              COALESCE(SUM(status = 'error'), 0) AS errors,
              COALESCE(SUM(state_truncated), 0) AS truncated,
              SUM(CASE WHEN status = 'applied' THEN tokens_before END) AS tokens_before,
              SUM(CASE WHEN status = 'applied' THEN tokens_after END) AS tokens_after
         FROM compactions WHERE ts >= ?`,
    )
    .get(since) as unknown as Totals;

  if (totals.total === 0) {
    return `Laya compaction stats (${scope}): no compactions recorded yet.`;
  }

  const lines = [`Laya compaction stats (${scope}; token counts are estimates)`];
  lines.push(
    `Compactions: ${totals.total} (${totals.applied} applied, ${totals.below} fell back to the built-in summary, ${totals.errors} failed)`,
  );

  if (totals.applied > 0) {
    const before = totals.tokens_before ?? 0;
    const after = totals.tokens_after ?? 0;
    lines.push(
      `Transcript tokens in applied compactions: ${n(before)} seen -> ${n(after)} let through (${pct(after, before)}), ${n(before - after)} dropped (${pct(before - after, before)})`,
    );

    const byTool = db
      .prepare(
        `SELECT d.tool AS tool, COUNT(*) AS calls,
                SUM(d.action = 'drop_call') AS calls_dropped,
                SUM(d.action = 'drop_result') AS results_cut,
                SUM(d.tokens_kept) AS kept, SUM(d.tokens_dropped) AS dropped
           FROM decisions d JOIN compactions c ON c.id = d.compaction_id
          WHERE c.ts >= ? AND c.status = 'applied'
          GROUP BY d.tool ORDER BY dropped DESC, calls DESC`,
      )
      .all(since) as unknown as {
      tool: string;
      calls: number;
      calls_dropped: number;
      results_cut: number;
      kept: number;
      dropped: number;
    }[];

    if (byTool.length > 0) {
      const rows = byTool.map((t) => [
        t.tool,
        n(t.calls),
        n(t.calls_dropped),
        n(t.results_cut),
        n(t.kept),
        n(t.dropped),
        pct(t.dropped, t.kept + t.dropped),
      ]);
      const header = ['tool', 'calls', 'removed', 'truncated', 'kept tok', 'dropped tok', 'dropped'];
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
      const fmt = (r: string[]): string =>
        r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ');
      lines.push('', 'Tool calls (kept = let through, dropped = removed or cut from results):', fmt(header));
      for (const r of rows) lines.push(fmt(r));
    }
  }

  const recent = db
    .prepare(
      `SELECT ts, status, error, tokens_before, tokens_after, messages_before, messages_after, state_truncated
         FROM compactions WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT 5`,
    )
    .all(since) as unknown as {
    ts: number;
    status: string;
    error: string | null;
    tokens_before: number;
    tokens_after: number;
    messages_before: number;
    messages_after: number;
    state_truncated: number;
  }[];
  lines.push('', 'Latest compactions:');
  for (const c of recent) {
    const when = new Date(c.ts).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(
      c.status === 'error'
        ? `  ${when}  failed: ${c.error ?? 'unknown error'}`
        : `  ${when}  ${c.status === 'applied' ? 'applied ' : 'fell back'}  ${n(c.tokens_before)} -> ${n(c.tokens_after)} tok, ${c.messages_before} -> ${c.messages_after} messages${c.state_truncated ? '  (state was cut off by Laya)' : ''}`,
    );
  }

  if (totals.truncated > 0) {
    lines.push(
      '',
      `Warning: in ${totals.truncated} compaction(s) Laya cut off part of the state (over its 8192-token limit). Lower "Maximum Laya state tokens" in /config.`,
    );
  }
  return lines.join('\n');
}
