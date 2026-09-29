import { parseRecord } from './stats-record.js';
import { buildReport, openStats, recordCompaction, statsDbPath } from './stats.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === 'record') {
    const record = parseRecord(await readStdin());
    const db = openStats();
    try {
      recordCompaction(db, record);
    } finally {
      db.close();
    }
    return;
  }
  if (command === 'report') {
    const days = argument && argument !== 'all' ? Number(argument.replace(/d$/i, '')) : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
      throw new Error(`"${argument}" is not a number of days; use e.g. 7, 30d or all`);
    }
    const db = openStats();
    try {
      const text = buildReport(db, days === undefined ? {} : { days });
      process.stdout.write(`${text}\nDatabase: ${statsDbPath()}\n`);
    } finally {
      db.close();
    }
    return;
  }
  throw new Error('usage: stats-cli record < record.json | stats-cli report [days|all]');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
