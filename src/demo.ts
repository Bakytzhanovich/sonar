// End-to-end demo: signup -> bot -> flow -> publish -> trigger -> test mode
// -> real (mock) webhook -> idempotent redelivery -> 24h window failure.
// Runs against a real HTTP server (not in-process function calls) so it
// exercises the same path an actual client would.
import { Pool } from 'pg';
import { createApp } from './api';
import { createDb, defaultConnectionString, exec, withSearchPath, type Db } from './db';

const BASE_CONNECTION_STRING = defaultConnectionString();
const DEMO_SCHEMA = 'demo';

async function main() {
  // Fresh DB every run — a demo should be repeatable, not fail on the
  // second run because of a UNIQUE(email) collision from the first.
  // Postgres has no ":memory:"/delete-the-file equivalent, so this drops
  // and recreates a dedicated "demo" schema instead (a namespace within
  // the same database, not a second physical database to provision), then
  // createDb() applies schema.sql against it exactly like a first run.
  await resetDemoSchema();
  const db = await createDb({
    connectionString: withSearchPath(BASE_CONNECTION_STRING, DEMO_SCHEMA),
  });
  const app = createApp(db);

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://localhost:${port}`;

  try {
    await runScenario(baseUrl, db);
  } finally {
    server.close();
    await db.end();
  }
}

async function resetDemoSchema(): Promise<void> {
  const pool = new Pool({ connectionString: BASE_CONNECTION_STRING });
  await pool.query(`DROP SCHEMA IF EXISTS "${DEMO_SCHEMA}" CASCADE; CREATE SCHEMA "${DEMO_SCHEMA}";`);
  await pool.end();
}

async function runScenario(baseUrl: string, db: Db) {
  section('1. Sign up a tenant');
  const { tenant, apiKey } = await post(baseUrl, '/api/tenants', {
    name: 'Aigerim Blogger',
    email: 'aigerim@example.com',
  });
  // Never print a full secret, even in a demo — same rule as production
  // OAuth tokens: "никогда не в логах".
  log(`tenant created: ${tenant.id}, apiKey: ${apiKey.slice(0, 8)}...(hidden)`);

  section('2. Create a bot for her Instagram account');
  const { bot } = await post(baseUrl, '/api/bots', { name: 'Aigerim Bot', externalAccountId: 'ig-aigerim' }, apiKey);
  log(`bot created: ${bot.id}`);

  section('3. Draft and publish a flow: "цена" -> DM with the price');
  const definition = {
    nodes: [
      { id: 'trig', type: 'trigger', position: { x: 0, y: 0 }, data: { keyword: 'цена', matchType: 'contains' } },
      {
        id: 'msg1',
        type: 'send_message',
        position: { x: 0, y: 100 },
        data: { text: 'Курс стоит 15 000 тг, вот ссылка на оплату: ...' },
      },
    ],
    edges: [{ id: 'e1', source: 'trig', target: 'msg1' }],
  };
  const { flow } = await post(baseUrl, `/api/bots/${bot.id}/flows`, { definition }, apiKey);
  await post(baseUrl, `/api/flows/${flow.id}/versions/${flow.version}/publish`, {}, apiKey);
  log(`flow ${flow.id} v${flow.version} published`);

  section('4. Bind the trigger');
  const { trigger } = await post(
    baseUrl,
    `/api/bots/${bot.id}/triggers`,
    { keyword: 'цена', flowId: flow.id, flowVersion: flow.version },
    apiKey
  );
  log(`trigger bound: "${trigger.keyword}" -> flow ${trigger.flow_id}`);

  // A second trigger on the same flow, used later to demonstrate the 24h
  // window: the window is scoped to the subscriber, not to a trigger, so
  // reusing "цена" for step 8 would hit the per-day dedup on that trigger
  // first and never reach the window check at all.
  const { trigger: secondTrigger } = await post(
    baseUrl,
    `/api/bots/${bot.id}/triggers`,
    { keyword: 'старт', flowId: flow.id, flowVersion: flow.version },
    apiKey
  );
  log(`second trigger bound: "${secondTrigger.keyword}" (used in step 8 below)`);

  section('5. Test mode (must not touch the database)');
  const dashboardBefore = await get(baseUrl, `/api/bots/${bot.id}/dashboard`, apiKey);
  const testResult = await post(
    baseUrl,
    `/api/bots/${bot.id}/test`,
    { externalUserId: 'preview-user', messageText: 'а почём цена?' },
    apiKey
  );
  const dashboardAfter = await get(baseUrl, `/api/bots/${bot.id}/dashboard`, apiKey);
  log(`test run status: ${testResult.outcome.status}, sent: ${JSON.stringify(testResult.outcome.sentMessages)}`);
  log(`subscriberCount unchanged by test mode: ${dashboardBefore.subscriberCount} -> ${dashboardAfter.subscriberCount}`);

  section('6. A real subscriber comments "цена" — mock Instagram webhook fires');
  const webhookPayload = {
    eventId: 'evt-001',
    externalAccountId: 'ig-aigerim',
    externalUserId: 'ig_user_42',
    messageText: 'напишите цена пожалуйста',
  };
  const first = await post(baseUrl, '/webhooks/mock/instagram', webhookPayload);
  log(`outcome: ${first.outcome.status}, sent: ${JSON.stringify(first.outcome.sentMessages)}`);

  section('7. Meta redelivers the exact same event (event_id) — must be a no-op');
  const redelivered = await post(baseUrl, '/webhooks/mock/instagram', webhookPayload);
  log(`second delivery result: ${JSON.stringify(redelivered)}`);

  section('8. 25 hours later, same subscriber trips a *different* trigger — DM window closed, no fallback configured');
  await backdateSubscriberOutsideWindow(db, 'ig_user_42');
  const stale = await post(baseUrl, '/webhooks/mock/instagram', {
    eventId: 'evt-002',
    externalAccountId: 'ig-aigerim',
    externalUserId: 'ig_user_42',
    messageText: 'старт',
  });
  log(`outcome: ${stale.outcome.status}, failureReason: ${stale.outcome.failureReason} (expected, not a bug)`);

  section('9. Final dashboard');
  const finalDashboard = await get(baseUrl, `/api/bots/${bot.id}/dashboard`, apiKey);
  log(JSON.stringify(finalDashboard, null, 2));
}

// Demo-only: reaches into the DB directly to simulate 25 hours passing,
// since this script has no way to fast-forward a real clock. There is
// deliberately no API endpoint that does this — it would make no sense
// outside of a demo/test context.
async function backdateSubscriberOutsideWindow(db: Db, externalUserId: string): Promise<void> {
  const staleTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await exec(db, `UPDATE subscribers SET last_interacted_at = ? WHERE external_user_id = ?`, staleTimestamp, externalUserId);
}

async function post(baseUrl: string, urlPath: string, body: unknown, apiKey?: string): Promise<any> {
  return request(baseUrl, 'POST', urlPath, body, apiKey);
}

async function get(baseUrl: string, urlPath: string, apiKey?: string): Promise<any> {
  return request(baseUrl, 'GET', urlPath, undefined, apiKey);
}

async function request(baseUrl: string, method: string, urlPath: string, body: unknown, apiKey?: string): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  // The mock webhook is gated by a shared secret (src/webhookAuth.ts) since
  // it can drive real flow runs. The demo drives it over HTTP like Meta
  // would, so it has to present the same secret the server was started with.
  if (urlPath.startsWith('/webhooks/') && process.env.MOCK_WEBHOOK_SECRET) {
    headers['x-sonar-webhook-secret'] = process.env.MOCK_WEBHOOK_SECRET;
  }

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function log(message: string) {
  console.log(message);
}

main().catch((err) => {
  if (!process.env.MOCK_WEBHOOK_SECRET) {
    console.error(
      '\nПодсказка: шаги с вебхуком требуют MOCK_WEBHOOK_SECRET (и сервера, запущенного с MOCK_WEBHOOK_ENABLED=true и тем же секретом).\n'
    );
  }
  console.error(err);
  process.exit(1);
});
