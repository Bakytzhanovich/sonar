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
  // Skip the schema check and the migrations. For a process connecting with
  // a least-privilege role that has no DDL rights — and should not have
  // them: the render worker parses untrusted files, and the point of
  // narrowing its role is that a compromise there cannot reshape the
  // database. Schema changes belong to the API's boot, which runs first.
  skipSchemaSetup?: boolean;
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
  const pool = new Pool({
    connectionString,
    // Why a bare `new Pool` was not enough, and what each of these prevents.
    //
    // The worker holds one connection open across a poll every five seconds,
    // over the public internet, to a managed database. That socket dies
    // without telling anyone: a NAT table drops the idle mapping, a laptop
    // suspends, the provider recycles the backend. No FIN arrives, so the
    // kernel still believes the connection is fine, and a query written to it
    // is simply never answered.
    //
    // With no timeout that await never settles. The worker's poll loop has a
    // catch around it, but nothing to catch — it just stops, mid-await, while
    // the process stays alive and idle. That is exactly what happened: a
    // worker up for 22 hours, 16 seconds of CPU, claiming nothing, reporting
    // nothing, with every client's render queued behind it.
    //
    // keepAlive makes the kernel probe the peer, so a dead socket surfaces as
    // an error instead of silence. The timeouts are the backstop for
    // everything keepAlive does not catch: a query that hangs now rejects, the
    // existing catch logs it, backs off, and the next tick opens a fresh
    // connection. A stall becomes a retry rather than a silent stop.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    // Generous on purpose: this also bounds the pg_advisory_lock wait below,
    // where two instances booting against one fresh database queue behind each
    // other. Schema init takes well under a second, so 30s is slack, not a
    // budget.
    query_timeout: 30_000,
  });

  // The other half of the paragraph above, and the half whose absence undid
  // it.
  //
  // A socket that dies while its client sits IDLE in the pool has no query to
  // reject — pg reports it by emitting 'error' on the pool instead. That is an
  // EventEmitter 'error' event, so with nothing listening Node does not log it,
  // it throws, and the process is gone. keepAlive is what makes this the
  // common case rather than a rare one: probing the peer is precisely what
  // turns a quietly dead socket into this event.
  //
  // So the laptop-suspends case swapped one failure for another. Before, the
  // worker hung forever holding the queue; after, it exited on the first sleep
  // and nothing restarted it — measured at 13 hours dead, which is how long it
  // took someone to look.
  //
  // Swallowing is the whole fix. pg has already discarded the broken client by
  // the time this runs, so the next tick asks the pool for a connection and
  // gets a new one. There is nothing to reconnect and nothing to clean up —
  // only a process to keep alive long enough to do it.
  pool.on('error', (err) => {
    // Not console.error: this is the expected sound of a laptop waking up, and
    // dressing it as a failure teaches whoever reads the log to ignore the
    // word "error" here.
    console.warn('[db] idle connection dropped, will reconnect on next query:', err.message);
  });

  // Session-level advisory lock around the check+apply, so that starting
  // multiple server instances against the same fresh database at once (a
  // multi-replica deploy, or several tests racing to init the same schema)
  // serializes instead of both seeing "no tenants table yet" and both
  // running schema.sql — the second CREATE TABLE would then fail outright,
  // since schema.sql has no IF NOT EXISTS guard (on purpose — see below).
  if (options.skipSchemaSetup) return pool;

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
  // Login throttling (see users table in schema.sql).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS subtitle_preset TEXT NOT NULL DEFAULT 'classic'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS remove_breaths BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS transcript_cache (
     audio_hash TEXT PRIMARY KEY,
     words      JSONB NOT NULL,
     text       TEXT NOT NULL,
     language   TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_video_edit_jobs_pipeline ON video_edit_jobs(pipeline, status, claimed_at)`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS subtitle_position TEXT NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS headline TEXT`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS headline_font TEXT NOT NULL DEFAULT 'montserrat'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS headline_size TEXT NOT NULL DEFAULT 'medium'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS headline_color TEXT NOT NULL DEFAULT 'white'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS aspect_ratio TEXT NOT NULL DEFAULT '9_16'`,
  // Manual re-edits (Module 8, level 3). A person who dislikes the automatic
  // cut draws their own segments and the job is rendered again — as a new row
  // pointing back at the one it came from, never in place, so the render they
  // already have survives an edit that turns out worse or fails outright.
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS parent_job_id TEXT REFERENCES video_edit_jobs(id)`,
  // The segments that person drew, in the SOURCE timeline. Present only on a
  // revision, and its presence is what tells the pipeline to skip the planner
  // entirely rather than re-derive cuts it was explicitly told.
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS manual_segments JSONB`,
  `CREATE INDEX IF NOT EXISTS idx_video_edit_jobs_parent ON video_edit_jobs(parent_job_id)`,
  // Caption look, split into axes the preset used to bundle (subtitleAxes.ts).
  // 'auto' and the neutral 'medium' mean "whatever the preset says", which is
  // what leaves every job rendered before this looking exactly as it did.
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS subtitle_font TEXT NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS subtitle_color TEXT NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS subtitle_size TEXT NOT NULL DEFAULT 'medium'`,
  // A few seconds of the same source, rendered to show what a caption style
  // will actually look like before committing to the whole video. Set to the
  // job being previewed, which is also what keeps these out of the queue the
  // user reads — they are a question being answered, not work they ordered.
  `ALTER TABLE video_edit_jobs ADD COLUMN IF NOT EXISTS preview_of TEXT REFERENCES video_edit_jobs(id)`,
  `CREATE INDEX IF NOT EXISTS idx_video_edit_jobs_preview ON video_edit_jobs(preview_of)`,
  `CREATE TABLE IF NOT EXISTS worker_heartbeats (
     worker_kind  TEXT PRIMARY KEY,
     last_seen_at TIMESTAMPTZ NOT NULL
   )`,
  // The worker connects as a least-privilege role (src/worker-role.sql) that
  // is granted table by table, so a table added here is unreachable to it
  // until granted. Done at boot by the API, which owns the schema, because
  // the alternative is a manual psql step that a deploy will forget — and the
  // symptom would be a worker that renders fine but never reports itself.
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sonar_worker') THEN
       GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO sonar_worker;
     END IF;
   END $$`,
  // ---- Module 3: real reel analysis -------------------------------------
  // The analysis used to be computed in the request from a hash of the URL —
  // a made-up result of a video nobody opened. It now runs in the worker
  // over an uploaded file, so a row exists before its result does: the
  // result columns lose NOT NULL, and a status says which state it is in.
  // Existing rows are finished ones, hence the default.
  `ALTER TABLE reel_analyses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'`,
  `ALTER TABLE reel_analyses ADD COLUMN IF NOT EXISTS stage TEXT`,
  `ALTER TABLE reel_analyses ADD COLUMN IF NOT EXISTS source_object_key TEXT`,
  `ALTER TABLE reel_analyses ADD COLUMN IF NOT EXISTS transcript JSONB`,
  `ALTER TABLE reel_analyses ADD COLUMN IF NOT EXISTS language TEXT`,
  `ALTER TABLE reel_analyses ADD COLUMN IF NOT EXISTS why TEXT`,
  `ALTER TABLE reel_analyses ADD COLUMN IF NOT EXISTS failure_reason TEXT`,
  `ALTER TABLE reel_analyses ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE reel_analyses ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`,
  `ALTER TABLE reel_analyses ALTER COLUMN source_url DROP NOT NULL`,
  `ALTER TABLE reel_analyses ALTER COLUMN hook DROP NOT NULL`,
  `ALTER TABLE reel_analyses ALTER COLUMN duration_seconds DROP NOT NULL`,
  `ALTER TABLE reel_analyses ALTER COLUMN on_screen_text DROP NOT NULL`,
  `ALTER TABLE reel_analyses ALTER COLUMN structure DROP NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_reel_analyses_status ON reel_analyses(status, claimed_at)`,
  // The rows the old pipeline produced are fakes — a hook picked from four
  // templates by a hash of the URL, flagged "[мок]" in their screen text.
  // Left as 'completed' they would sit in the library looking like real
  // analyses. Marked instead, so the screen can say what they are.
  `UPDATE reel_analyses SET status = 'failed', failure_reason = 'legacy_mock'
     WHERE status = 'completed' AND on_screen_text LIKE '[мок]%'`,
  // The worker connects as a least-privilege role granted table by table;
  // without this it cannot see a single analysis to work on, and the failure
  // would read as a permission error inside every tick.
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sonar_worker') THEN
       GRANT SELECT, UPDATE ON reel_analyses TO sonar_worker;
     END IF;
   END $$`,
  // Module 5: a post is a video. Before these, a scheduled post was a caption
  // and a time, with nothing a reel platform could actually publish.
  `ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS video_object_key TEXT`,
  `ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS video_job_id TEXT`,
  // Module 5: connected social accounts. The token column holds ciphertext
  // only — see tokenVault.ts.
  `CREATE TABLE IF NOT EXISTS platform_accounts (
     id                TEXT PRIMARY KEY,
     seq               BIGSERIAL,
     tenant_id         TEXT NOT NULL REFERENCES tenants(id),
     platform          TEXT NOT NULL,
     external_user_id  TEXT NOT NULL,
     username          TEXT,
     token_ciphertext  TEXT NOT NULL,
     token_expires_at  TIMESTAMPTZ,
     status            TEXT NOT NULL DEFAULT 'active',
     is_test           BOOLEAN NOT NULL DEFAULT false,
     connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
     refreshed_at      TIMESTAMPTZ,
     UNIQUE (tenant_id, platform, external_user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_platform_accounts_expiry ON platform_accounts(status, token_expires_at)`,
  // Module 6: the topic plan read from buyers' messages (contentTopics.ts).
  `CREATE TABLE IF NOT EXISTS content_plans (
     tenant_id     TEXT PRIMARY KEY REFERENCES tenants(id),
     topics        JSONB NOT NULL,
     source_hash   TEXT NOT NULL,
     generated_at  TIMESTAMPTZ NOT NULL
   )`,
  // Module 6: the week the topics are filmed in (contentCalendar.ts).
  `CREATE TABLE IF NOT EXISTS content_calendar (
     id          TEXT PRIMARY KEY,
     tenant_id   TEXT NOT NULL REFERENCES tenants(id),
     day         DATE NOT NULL,
     topic_id    TEXT,
     title       TEXT NOT NULL,
     segment     TEXT NOT NULL,
     script      TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_content_calendar_day ON content_calendar(tenant_id, day)`,
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
