import { Pool, type PoolClient, types } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

// __dirname resolves to src/ under tsx (dev/demo/tests) and to dist/ after
// `npm run build` — the build script copies schema.sql alongside the
// compiled JS specifically so this path keeps working in both cases.
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// pg's default behavior parses timestamptz columns into JS Date objects.
// The app was written against SQLite, where every timestamp is a plain
// ISO string end to end (stored, compared, JSON-serialized) — code does
// exact string equality checks against values it wrote with .toISOString().
// Postgres's own wire format for timestamptz is NOT that string (it comes
// back as '2026-08-19 16:00:00+05' — space-separated, server-local offset,
// no milliseconds when they're zero), so passing the raw driver string
// through still breaks those comparisons even though the underlying instant
// is correct. Routing it through Date first normalizes to the exact same
// ISO-with-Z format the app already writes everywhere.
types.setTypeParser(1114, (value) => new Date(value).toISOString()); // timestamp
types.setTypeParser(1184, (value) => new Date(value).toISOString()); // timestamptz

// COUNT(*)/SUM(int) return Postgres bigint (OID 20), which pg returns as a
// string by default (a bigint can exceed Number.MAX_SAFE_INTEGER). This
// app's counts never approach that range, and better-sqlite3 — what this
// code was written against — always returned these as plain numbers, so
// parsing to a number here avoids silent `"0" === 0` bugs at call sites
// that compare a COUNT(*) result against a literal 0.
types.setTypeParser(20, (value) => Number(value)); // int8/bigint

export type Db = Pool;

export interface DbOptions {
  connectionString?: string;
}

// Arbitrary fixed key for the advisory lock below — any consistent bigint
// works, it just needs to not collide with a lock some other part of the
// app takes (nothing else takes one).
const SCHEMA_INIT_LOCK_ID = 847362910;

// Opens a connection pool and, on first use against an empty database,
// applies schema.sql. Detecting "empty" via information_schema rather than
// a version/migrations table because this project has no migration
// framework yet — one schema.sql, applied once, same as the SQLite skeleton
// this replaced.
export async function createDb(options: DbOptions = {}): Promise<Db> {
  const connectionString = options.connectionString ?? defaultConnectionString();
  const pool = new Pool({ connectionString });

  // Session-level advisory lock around the check+apply, so that starting
  // multiple server instances against the same fresh database at once (a
  // multi-replica deploy, or several tests racing to init the same schema)
  // serializes instead of both seeing "no tenants table yet" and both
  // running schema.sql — the second CREATE TABLE would then fail outright,
  // since schema.sql has no IF NOT EXISTS guard (on purpose — see below).
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_INIT_LOCK_ID]);
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'tenants'`
    );
    if (rows.length === 0) {
      const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
      await client.query(schema);
    } else {
      await applyMigrations(client);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_INIT_LOCK_ID]);
    client.release();
  }

  return pool;
}

// schema.sql is only ever applied to an empty database, so columns added
// after a deployment already exists would never appear there. Until this
// project adopts a real migration framework, additive changes go here as
// idempotent ALTERs — safe to run on every boot, and they keep a deployed
// Render/Neon database in step with schema.sql without a manual step.
//
// Additive only. A change that drops or rewrites a column does not belong in
// a boot-time hook running concurrently with live traffic.
const MIGRATIONS: string[] = [
  // Module 8, Level 3 (own FFmpeg engine) — see schema.sql for what each is.
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS pipeline TEXT NOT NULL DEFAULT 'preset'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS source_object_key TEXT`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS output_object_key TEXT`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS stage TEXT`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS artifacts JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS subtitles BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS poster_url TEXT`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS denoise_mode TEXT NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS review_mode TEXT NOT NULL DEFAULT 'auto'`,
  `CREATE INDEX IF NOT EXISTS idx_video_edit_jobs_pipeline ON video_edit_jobs(pipeline, status, claimed_at)`,
];

async function applyMigrations(client: PoolClient): Promise<void> {
  for (const statement of MIGRATIONS) {
    await client.query(statement);
  }
}

export async function closeDb(db: Db): Promise<void> {
  await db.end();
}

export function defaultConnectionString(): string {
  // Matches docker-compose.yml, which publishes the local dev Postgres on
  // host port 5435 (not the Postgres-standard 5432) to avoid colliding with
  // a native/other Postgres instance a developer's machine may already have
  // listening on 5432.
  return process.env.DATABASE_URL ?? 'postgresql://sonar:sonar@localhost:5435/sonar';
}

// Scopes a connection string to a Postgres schema (a namespace within one
// database — used by demo.ts and the test helper for isolation). Naively
// appending '?options=-c search_path=...' breaks when the base connection
// string already has query params (e.g. '?host=...&port=...' for a
// non-default unix socket dir) — the second '?' isn't a valid separator,
// so the schema override was silently dropped and every "isolated" caller
// ended up sharing the real 'public' schema instead. WHATWG URL can't help
// here either — it rejects the empty-host form ('postgresql://user@/db')
// that a unix-socket connection string legitimately uses — so this just
// checks for an existing '?' instead of fully parsing the string.
export function withSearchPath(connectionString: string, schema: string): string {
  const separator = connectionString.includes('?') ? '&' : '?';
  return `${connectionString}${separator}options=-c search_path=${schema}`;
}

// ---- Query helpers -------------------------------------------------------
// Every call site was written against better-sqlite3's
// `db.prepare(sql).all(...params)` / `.get(...params)` / `.run(...params)`,
// using '?' placeholders. Rather than rewrite every query string to '$1,
// $2, ...' by hand across ~10 files, these helpers keep the exact same
// call shape (sql string, then positional params) and do the '?' -> '$n'
// rewrite once, here. The SQL text callers write is unchanged from the
// SQLite version.
//
// Skips over single-quoted ('...', with '' as an escaped quote) and
// dollar-quoted ($$...$$) string content so a literal '?' inside a string
// literal isn't miscounted as a placeholder. Postgres's own jsonb
// key-existence operators (?, ?|, ?&) are NOT distinguishable from a
// placeholder by text scanning alone — no call site uses them today; a
// future query that needs one should write that one query's placeholders
// as raw '$1'-style SQL instead of relying on this converter.
function toPositional(sql: string): string {
  let i = 0;
  let out = '';
  let pos = 0;
  while (pos < sql.length) {
    const ch = sql[pos];
    if (ch === "'") {
      let end = pos + 1;
      while (end < sql.length) {
        if (sql[end] === "'") {
          if (sql[end + 1] === "'") { end += 2; continue; }
          end += 1;
          break;
        }
        end += 1;
      }
      out += sql.slice(pos, end);
      pos = end;
      continue;
    }
    // Comments are copied through verbatim. Without this an apostrophe in an
    // ordinary English comment ("the job's retries") reads as the start of a
    // string literal, the scanner runs to the next quote somewhere further
    // down the query, and every '?' it swallows on the way silently fails to
    // become a placeholder — the statement then reaches Postgres with the
    // wrong parameter count and fails as an opaque internal error.
    if (ch === '-' && sql[pos + 1] === '-') {
      const newline = sql.indexOf('\n', pos);
      const end = newline === -1 ? sql.length : newline;
      out += sql.slice(pos, end);
      pos = end;
      continue;
    }
    if (ch === '/' && sql[pos + 1] === '*') {
      const close = sql.indexOf('*/', pos + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(pos, end);
      pos = end;
      continue;
    }
    if (ch === '$' && sql[pos + 1] === '$') {
      const close = sql.indexOf('$$', pos + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(pos, end);
      pos = end;
      continue;
    }
    if (ch === '?') {
      out += `$${++i}`;
      pos += 1;
      continue;
    }
    out += ch;
    pos += 1;
  }
  return out;
}

// Pool and a client checked out via pool.connect() both expose the same
// .query(sql, params) shape — widening these helpers to accept either lets
// a caller that needs an explicit transaction (BEGIN/COMMIT on one checked-
// out client, e.g. the onboarding demo-workspace bootstrap) still go
// through the shared '?' -> '$n' conversion instead of hand-writing $n SQL.
export type Queryable = Pool | PoolClient;

export async function queryAll<T = unknown>(db: Queryable, sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await db.query(toPositional(sql), params);
  return result.rows as T[];
}

export async function queryOne<T = unknown>(db: Queryable, sql: string, ...params: unknown[]): Promise<T | undefined> {
  const rows = await queryAll<T>(db, sql, ...params);
  return rows[0];
}

export async function exec(db: Queryable, sql: string, ...params: unknown[]): Promise<void> {
  await db.query(toPositional(sql), params);
}

// Postgres error code for a unique_violation — replaces SQLite's
// `err.message.includes('UNIQUE constraint failed')` checks (flowEngine.ts,
// api.ts's webhook dedup), which relied on SQLite's specific error text.
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
