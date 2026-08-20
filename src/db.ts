import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// __dirname resolves to src/ under tsx (dev/demo/tests) and to dist/ after
// `npm run build` — the build script copies schema.sql alongside the
// compiled JS specifically so this path keeps working in both cases.
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export interface DbOptions {
  /** File path, or ':memory:' for an ephemeral DB (used by tests). */
  filePath?: string;
}

// Opens (and, on first run, creates) the SQLite database. Schema
// application is idempotent — CREATE TABLE has no IF NOT EXISTS guard in
// schema.sql on purpose, so re-running it against an already-initialized
// file fails loudly instead of silently drifting from schema.sql.
export function createDb(options: DbOptions = {}): Database.Database {
  const filePath = options.filePath ?? defaultDbPath();
  const isNewFile = filePath === ':memory:' || !fs.existsSync(filePath);

  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (isNewFile) {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schema);
  }

  return db;
}

function defaultDbPath(): string {
  return path.join(process.cwd(), 'data', 'sonar.db');
}
