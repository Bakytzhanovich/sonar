// Postgres has no ':memory:' equivalent to the SQLite setup this replaced.
// Instead, each test gets its own throwaway schema (a namespace within one
// shared database) — created fresh, torn down after — which gives the same
// full-isolation guarantee ':memory:' did, just against a real Postgres
// engine instead of a different one from what runs in prod.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDb, defaultConnectionString, withSearchPath, type Db } from '../src/db';

const BASE_CONNECTION_STRING = defaultConnectionString();

const schemaByPool = new WeakMap<Db, string>();

export async function createTestDb(): Promise<Db> {
  const schema = `test_${randomUUID().replace(/-/g, '_')}`;

  const admin = new Pool({ connectionString: BASE_CONNECTION_STRING });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();

  const db = await createDb({
    connectionString: withSearchPath(BASE_CONNECTION_STRING, schema),
  });
  schemaByPool.set(db, schema);
  return db;
}

export async function dropTestDb(db: Db): Promise<void> {
  const schema = schemaByPool.get(db);
  await db.end();
  if (!schema) return;

  const admin = new Pool({ connectionString: BASE_CONNECTION_STRING });
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
