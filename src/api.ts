import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec, isUniqueViolation, queryAll, queryOne, type Db } from './db';
import { createApiKeyForTenant, resolveTenantIdFromApiKey } from './apiKeys';
import { hashPassword, verifyPassword, signSession, verifySession, deriveKey, DUMMY_PASSWORD_HASH } from './auth';
import { MOCK_WEBHOOK_SECRET_HEADER, isMockWebhookEnabled, verifyMockWebhookSecret } from './webhookAuth';
import {
  ADMIN_SECRET_HEADER,
  evaluateGate,
  gateStartupWarnings,
  normalizeOrigin,
  signupAvailability,
  signupDecision,
} from './credentialGates';
import { clearSessionCookie, isAllowedOrigin, sessionTokenFromRequest, setSessionCookie } from './sessionCookie';
import { isLocked, nextFailureState, secondsUntilUnlock } from './loginThrottle';
import { DEFAULT_SUBTITLE_PRESET, isSubtitlePresetId, SUBTITLE_PRESETS } from './subtitlePresets';
import { DEFAULT_SUBTITLE_POSITION, isSubtitlePositionId, SUBTITLE_POSITIONS } from './subtitlePositions';
import { HEADLINE_MAX_CHARS, sanitizeHeadline } from './headline';
import { isAwaitingWorker } from './jobLease';
import { SMART_CUT_WORKER, isWorkerOnline } from './workerHealth';
import { runFlow, collectMessageNodes } from './flowEngine';
import { getActiveTriggersForBot, normalizeKeyword } from './triggerMatcher';
import { analyzeReelMock, generateScriptMock } from './reelAnalysis';
import { generateCarouselSlides } from './carouselGeneration';
import { publishDuePosts } from './publisher';
import { computeContentRecommendations } from './contentRecommendations';
import { advanceRenderJobs } from './videoRender';
import { downloadUrlFor, presign, storageConfigFromEnv } from './storage';
import { localMediaConfigFromEnv, resolveKeyPath, signLocalUrl, verifyLocalUrl } from './localMedia';
import { notify, listNotifications } from './notifications';
import { getOrCreateVapidKeys } from './vapidKeys';
import type {
  Bot,
  Carousel,
  CarouselSlide,
  FlowDefinition,
  GeneratedScript,
  ReelAnalysis,
  ScheduledPost,
  Subscriber,
  Trigger,
  User,
  VideoEditJob,
  VideoTemplate,
} from './types';

// Allow-list rather than a prefix check on 'video/': the value is signed
// into the upload URL and then echoed by the storage on download, so an
// unconstrained one lets a presigned "video" URL host anything, including
// text/html served from our own bucket domain.
const UPLOAD_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const UPLOAD_EXTENSIONS: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
// Long enough to upload a large clip on a phone connection, short enough that
// a leaked URL is not a lasting write grant on our bucket.
const UPLOAD_URL_TTL_SEC = 30 * 60;
// Ceiling for a single upload through the local dev store. A reel is a few
// hundred megabytes at most; without a cap one request can exhaust the
// process's memory, since express.raw buffers the whole body.
const MAX_UPLOAD_BYTES = 600 * 1024 * 1024;

const DEMO_BOT_NAME = 'Sonar Demo';
const DEMO_EXTERNAL_USER_ID = 'sonar-demo-contact';

function demoExternalAccountId(tenantId: string): string {
  return `demo:${tenantId}`;
}

export function createApp(db: Db): Express {
  const app = express();

  // Rate limiting keys on req.ip, which behind a reverse proxy is the
  // proxy's own address unless Express is told how many hops to trust —
  // every user then shares one bucket, so 20 attempts from one attacker
  // locked login for everybody (a DoS, out of the very control meant to
  // stop brute force). Trusting X-Forwarded-For is only safe when a proxy
  // actually overwrites it, so this is opt-in per deployment rather than
  // on by default: Render sets TRUST_PROXY=1 (see render.yaml), local dev
  // leaves it unset, where trusting a client-supplied header would instead
  // let anyone bypass the limiter by inventing a new address per request.
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0));

  // Baseline response headers (HSTS, nosniff, frameguard, referrer policy).
  // contentSecurityPolicy is off: this process serves JSON to a separate
  // Next.js origin and never returns HTML, so a CSP here would protect
  // nothing while risking breaking the frontend's own headers.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.use(express.json());

  // See containsNullByte: a NUL anywhere in the body would otherwise reach
  // Postgres and fail the statement, turning bad input into a server error.
  app.use((req, res, next) => {
    if (containsNullByte(req.body)) return res.status(400).json({ error: 'null_byte_in_request' });
    next();
  });

  // Credential endpoints are the most commonly attacked surface (password
  // brute force, credential stuffing, mass account creation) — CLAUDE.md
  // calls out rate limiting explicitly for autoposting; these need the same
  // protection. In-memory store is fine while the app is single-process
  // (Redis is planned but not wired yet, same stage as the rest of this
  // codebase's mocked infra) — declared inside createApp so every test
  // (which calls createApp fresh per test) gets its own isolated limiter
  // state instead of sharing one counter across the whole test run.
  const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
  });

  // The mock webhook authenticates with a shared secret rather than a
  // tenant credential, so it gets its own limiter: without one, a caller
  // holding the secret (or brute-forcing it) could drive unbounded flow
  // runs, and every run is a DM sent from a client's real account once the
  // platform integration is live — exactly the account-ban risk CLAUDE.md
  // calls out. Keyed the same way as authRateLimit, so it inherits the
  // trust-proxy setting above.
  const webhookRateLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
  });

  // CORS_ORIGIN pins this to the deployed frontend once one exists;
  // defaults to permissive for local dev. `||` rather than `??` on purpose:
  // a declared-but-unset host env var (Render's `sync: false` leaves the
  // dashboard field blank) arrives as '' and would emit an empty
  // Access-Control-Allow-Origin header, breaking every cross-origin call.
  // Protected routes use a Bearer credential (an API key for integrations
  // or a session JWT for the first-party product), not a cookie, so
  // there's no CSRF surface being widened by the permissive default.
  // Wildcard is a development convenience, and only that. In production an
  // unset CORS_ORIGIN now means "no cross-origin access" rather than "any
  // site" — the safe reading of someone leaving the field blank.
  //
  // This costs the deployment nothing: the frontend proxies /api/* through
  // its own origin, so its requests are same-origin and never consult CORS
  // at all. What it does cost is the ability of an arbitrary page to call
  // this API from a browser, which is the entire point.
  // Normalised, not taken as typed. A value pasted into a hosting panel
  // arrives with a trailing newline often enough that it is worth handling:
  // Node refuses to put a newline in a header and throws ERR_INVALID_CHAR on
  // every response, /health included, so the platform never sees a healthy
  // instance and the deploy hangs rather than failing with the reason.
  //
  // The trailing slash goes too. An Origin header never carries one, so
  // "https://app.example.com/" would match nothing and silently reject every
  // state-changing request — a subtler failure than the crash.
  const configuredOrigin = normalizeOrigin(process.env.CORS_ORIGIN);
  const isProduction = process.env.NODE_ENV === 'production';
  const corsOrigin = configuredOrigin || (isProduction ? null : '*');

  if (!configuredOrigin && isProduction) {
    console.warn('[api] CORS_ORIGIN is unset — cross-origin browser requests are refused; set it if a frontend calls this API directly');
  }

  // The two routes that mint a credential without needing one. See
  // credentialGates.ts for why an unset secret closes them rather than
  // opening them.
  const adminBootstrapSecret = process.env.ADMIN_BOOTSTRAP_SECRET ?? null;
  const signupInviteCode = process.env.SIGNUP_INVITE_CODE ?? null;
  const signupMode = process.env.SIGNUP_MODE;
  for (const warning of gateStartupWarnings(process.env)) console.warn(warning);

  app.use((req, res, next) => {
    if (corsOrigin) {
      res.header('Access-Control-Allow-Origin', corsOrigin);
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, PATCH, DELETE, OPTIONS');
      // Only meaningful with a pinned origin: the browser refuses to send
      // credentials to a wildcard, which is the correct behaviour and the
      // reason CORS_ORIGIN must be set for a directly-addressed API.
      if (corsOrigin !== '*') res.header('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);

    // Server-side CSRF guard behind SameSite=Lax — see sessionCookie.ts.
    if (!isAllowedOrigin(req, corsOrigin ?? '')) return res.status(403).json({ error: 'origin_not_allowed' });
    next();
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // ---- Local media store (development stand-in for R2) --------------------
  // Mounted BEFORE requireProductCredential on purpose: like a presigned S3
  // URL, the signature in the query string IS the credential. A <video> tag
  // cannot send an Authorization header, so a token-in-URL scheme is what
  // makes a finished render playable in the browser at all.
  const localMedia = localMediaConfigFromEnv(deriveKey('local-media'));

  if (localMedia) {
    app.put('/api/media/*', express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }), asyncHandler(async (req, res) => {
      const key = decodeURIComponent((req.params as unknown as string[])[0] ?? '');
      if (!verifyLocalUrl(localMedia, 'PUT', key, req.query.exp, req.query.token)) {
        return res.status(403).json({ error: 'invalid_or_expired_upload_url' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty_body' });

      const target = resolveKeyPath(localMedia, key);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, req.body);
      res.status(200).json({ objectKey: key, bytes: req.body.length });
    }));

    app.get('/api/media/*', asyncHandler(async (req, res) => {
      const key = decodeURIComponent((req.params as unknown as string[])[0] ?? '');
      if (!verifyLocalUrl(localMedia, 'GET', key, req.query.exp, req.query.token)) {
        return res.status(403).json({ error: 'invalid_or_expired_url' });
      }
      try {
        const target = resolveKeyPath(localMedia, key);
        await fsp.access(target);
        // The <a download> attribute is ignored cross-origin, and the API is
        // a different origin from the frontend (:4001 vs :3001), so a
        // "download" link opened the raw file in a new tab with no history
        // to go back through. Saying it server-side is what actually saves
        // the file; the player omits the flag and still streams normally.
        if (req.query.download !== undefined) {
          res.setHeader('Content-Disposition', `attachment; filename="${path.basename(key)}"`);
        }
        // helmet defaults Cross-Origin-Resource-Policy to same-origin, and the
        // frontend is a different origin from this API (:3001 vs :4001). The
        // browser then refuses to paint a <video poster> from here — the
        // request never even leaves it (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin),
        // so the card showed a black rectangle and the job looked like it had
        // produced nothing. These URLs are already unguessable and expiring;
        // the policy adds nothing here but the blockage.
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        // sendFile rather than reading into memory: a render is tens of
        // megabytes and the browser seeks around it while playing.
        res.sendFile(target);
      } catch {
        res.status(404).json({ error: 'not_found' });
      }
    }));
  }

  // ---- Tenant bootstrap (not API-key protected — this is how a tenant
  // gets its first key; equivalent to a signup step). --------------------
  app.post('/api/tenants', authRateLimit, asyncHandler(async (req, res) => {
    const gate = evaluateGate({
      isProduction,
      configuredSecret: adminBootstrapSecret,
      providedSecret: req.header(ADMIN_SECRET_HEADER),
    });
    if (!gate.allowed) {
      // 404 when the route is closed outright: there is no reason to confirm
      // that a key-issuing endpoint exists here. A wrong secret gets 401,
      // because at that point the caller already knows.
      return gate.reason === 'not_configured'
        ? res.status(404).json({ error: 'not_found' })
        : res.status(401).json({ error: 'invalid_admin_secret' });
    }

    const { name, email } = req.body ?? {};
    if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

    const tenantId = randomUUID();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, ?, ?)`, tenantId, name, email);
    const apiKey = await createApiKeyForTenant(db, tenantId);

    // apiKey is shown exactly once, right here — it is not retrievable
    // again (only its hash is stored).
    res.status(201).json({ tenant: { id: tenantId, name, email }, apiKey });
  }));

  // ---- Auth (Логика Б: public self-serve signup) -------------------------
  // Additive, parallel to the staff-assisted POST /api/tenants above — that
  // route (and the API-key flow it issues) is untouched. Signup here makes
  // its own tenant + a password-holding user row, and hands back a session
  // JWT that the first-party product can use on the same tenant-scoped API.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MIN_PASSWORD_LENGTH = 8;

  // Public on purpose: it reveals only whether this deployment asks for an
  // invite, which anyone learns by loading the signup page anyway.
  app.get('/api/auth/signup-config', (_req, res) => {
    res.json({ signup: signupAvailability({ isProduction, signupMode, configuredSecret: signupInviteCode }) });
  });

  app.post('/api/auth/signup', authRateLimit, asyncHandler(async (req, res) => {
    const rawEmail = req.body?.email;
    const { password } = req.body ?? {};
    if (typeof rawEmail !== 'string' || !EMAIL_RE.test(rawEmail)) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'invalid_password', minLength: MIN_PASSWORD_LENGTH });
    }

    // Checked before the email lookup below, so a caller without an invite
    // cannot use signup to find out which addresses are registered.
    const gate = signupDecision({
      isProduction,
      signupMode,
      configuredSecret: signupInviteCode,
      providedSecret: req.body?.inviteCode,
    });
    if (!gate.allowed) {
      return res.status(403).json({
        error: gate.reason === 'not_configured' ? 'signup_closed' : 'invalid_invite_code',
      });
    }
    // Email identity must be case-insensitive (RFC 5321 leaves the local
    // part case-sensitive in theory, but no mainstream provider treats it
    // that way) — normalize before the uniqueness check/storage so
    // "Aibek@gmail.com" and "aibek@gmail.com" are the same account.
    const email = rawEmail.trim().toLowerCase();

    const existing = await queryOne<{ id: string }>(db, `SELECT id FROM users WHERE email = ?`, email);
    if (existing) return res.status(409).json({ error: 'email_taken' });

    const tenantId = randomUUID();
    const userId = randomUUID();
    const passwordHash = await hashPassword(password);

    try {
      // No explicit transaction (same convention as POST /api/tenants
      // above) — ids are generated client-side, so a crash between the two
      // inserts leaves an orphan tenant row rather than a corrupt
      // reference; users.email UNIQUE is still the real race guard below.
      await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, ?, ?)`, tenantId, email, email);
      await exec(db, `INSERT INTO users (id, tenant_id, email, password_hash) VALUES (?, ?, ?, ?)`, userId, tenantId, email, passwordHash);
    } catch (err) {
      // Two signups racing on the same email: both pass the SELECT above,
      // one wins the INSERT, the other hits users.email's UNIQUE
      // constraint — the DB constraint is the real guard, the SELECT above
      // is just a fast path that avoids a wasted bcrypt hash most of the time.
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'email_taken' });
      throw err;
    }

    const sessionToken = signSession({ userId, tenantId });
    // The cookie is the credential the browser will actually use. The token
    // stays in the body for non-browser clients (the CLI demo, tests, any
    // integration), which cannot receive a cookie jar.
    setSessionCookie(res, sessionToken);
    res.status(201).json({ user: { id: userId, email }, tenant: { id: tenantId, name: email }, sessionToken });
  }));

  app.post('/api/auth/login', authRateLimit, asyncHandler(async (req, res) => {
    const { email: rawEmail, password } = req.body ?? {};
    if (typeof rawEmail !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const email = rawEmail.trim().toLowerCase();

    // Same error for "no such user" and "wrong password" — a distinct
    // "no such user" response would let a caller enumerate registered
    // emails by probing this endpoint.
    //
    // The hash comparison also runs when no user matched, against a fixed
    // dummy hash: bcrypt at cost 12 takes ~100ms, so skipping it for an
    // unknown email made "not registered" answer measurably faster than
    // "wrong password" — the identical error message above could then be
    // sidestepped by timing the response instead of reading it.
    const user = await queryOne<User>(db, `SELECT * FROM users WHERE email = ?`, email);
    const now = new Date();

    // Checked before the password: a locked account gets the same answer
    // whatever is typed, so the lock cannot be probed for the right one.
    if (isLocked(user, now)) {
      return res.status(429).json({ error: 'account_locked', retryAfterSec: secondsUntilUnlock(user, now) });
    }

    const passwordMatches = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) {
      // Only a real account has a counter to raise. An unknown email is not
      // recorded at all — there is nothing to protect, and writing a row per
      // guessed address would hand an attacker a way to fill the table.
      if (user) {
        const next = nextFailureState(user, now);
        await exec(
          db,
          `UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`,
          next.failedLogins,
          next.lockedUntil ? next.lockedUntil.toISOString() : null,
          user.id
        );
      }
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    // The right password ends the lock immediately, so an attacker cannot
    // keep the owner out by failing on purpose — they are delayed, not
    // locked out.
    if (user.failed_logins > 0 || user.locked_until) {
      await exec(db, `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`, user.id);
    }

    const tenant = await queryOne<{ id: string; name: string }>(db, `SELECT id, name FROM tenants WHERE id = ?`, user.tenant_id);
    const sessionToken = signSession({ userId: user.id, tenantId: user.tenant_id });
    setSessionCookie(res, sessionToken);
    res.json({ user: { id: user.id, email: user.email }, tenant, sessionToken });
  }));

  // Signing out has to happen server-side now: an httpOnly cookie is by
  // design not something the page can delete itself.
  app.post('/api/auth/logout', asyncHandler(async (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', requireSession(db), asyncHandler(async (req, res) => {
    const { userId, tenantId } = res.locals.session as { userId: string; tenantId: string };
    const user = await queryOne<User>(db, `SELECT * FROM users WHERE id = ?`, userId);
    const tenant = await queryOne<{ id: string; name: string }>(db, `SELECT id, name FROM tenants WHERE id = ?`, tenantId);
    if (!user || !tenant) return res.status(401).json({ error: 'invalid_session' });
    res.json({ user: { id: user.id, email: user.email }, tenant });
  }));

  // Before the credential check on purpose: this is the application's own
  // catalogue of caption looks, not tenant data. The frontend needs it to
  // render the picker, including on a screen reached before sign-in.
  //
  // The frontend renders whatever this returns instead of keeping its own
  // copy — two lists drift, and these styles are defined in the renderer's
  // terms (ASS colour order), not the browser's.
  app.get('/api/subtitle-presets', (_req, res) => {
    res.json({
      presets: SUBTITLE_PRESETS.map(({ id, label, description }) => ({ id, label, description })),
      // Shipped alongside the looks rather than from a second endpoint: the
      // picker shows both, and one request means the two can never arrive out
      // of step with each other.
      positions: SUBTITLE_POSITIONS.map(({ id, label, description }) => ({ id, label, description })),
      // The renderer's limit, not a second copy of it in the browser.
      headlineMaxChars: HEADLINE_MAX_CHARS,
    });
  });

  app.use('/api', requireProductCredential(db));

  // ---- Bots --------------------------------------------------------------
  // Workspace discovery for both returning browser sessions and API-key
  // clients. Before this endpoint the frontend had to remember a bot id in
  // localStorage forever; a new browser could authenticate successfully but
  // had no supported way to recover the tenant's workspace.
  app.get('/api/bots', asyncHandler(async (_req, res) => {
    const bots = await queryAll<Bot>(
      db,
      `SELECT * FROM bots WHERE tenant_id = ? ORDER BY created_at ASC, id ASC`,
      res.locals.tenantId
    );
    res.json({ bots });
  }));

  app.post('/api/bots', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const { name, platform, externalAccountId } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const botId = randomUUID();
    await exec(
      db,
      `INSERT INTO bots (id, tenant_id, name, platform, external_account_id) VALUES (?, ?, ?, ?, ?)`,
      botId,
      tenantId,
      name,
      platform ?? 'instagram',
      externalAccountId ?? null
    );

    res.status(201).json({ bot: { id: botId, tenant_id: tenantId, name, platform: platform ?? 'instagram', external_account_id: externalAccountId ?? null } });
  }));

  // Creates the smallest complete workspace needed for first-run onboarding:
  // one demo bot, one already-published two-node flow, and one active trigger.
  // A tenant-scoped Postgres advisory lock makes the check+create sequence
  // idempotent even when a double click (or two tabs) sends concurrent calls;
  // schema changes solely for a one-off bootstrap marker are unnecessary.
  app.post('/api/onboarding/demo-workspace', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : '';
    const replyText = typeof req.body?.replyText === 'string' ? req.body.replyText.trim() : '';

    if (!keyword) return res.status(400).json({ error: 'keyword is required' });
    if (!replyText) return res.status(400).json({ error: 'replyText is required' });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await exec(client, `SELECT pg_advisory_xact_lock(hashtext(?))`, `sonar-demo-workspace:${tenantId}`);

      const externalAccountId = demoExternalAccountId(tenantId);
      let bot = await queryOne<Bot>(
        client,
        `SELECT * FROM bots WHERE tenant_id = ? AND external_account_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`,
        tenantId,
        externalAccountId
      );

      if (!bot) {
        bot = await queryOne<Bot>(
          client,
          `INSERT INTO bots (id, tenant_id, name, platform, external_account_id)
           VALUES (?, ?, ?, 'instagram', ?)
           RETURNING *`,
          randomUUID(),
          tenantId,
          DEMO_BOT_NAME,
          externalAccountId
        );
      }
      // INSERT ... RETURNING * on a single-row insert always yields exactly
      // one row — this narrows `bot` for TypeScript and would only trip if
      // that invariant somehow broke.
      if (!bot) throw new Error('failed to create demo bot');

      const existingWorkspace = await queryOne<{
        trigger_id: string;
        trigger_keyword: string;
        match_type: Trigger['match_type'];
        is_active: boolean;
        trigger_created_at: string;
        flow_id: string;
        flow_version: number;
        flow_status: 'published';
        definition: FlowDefinition;
        flow_created_at: string;
      }>(
        client,
        `SELECT
           triggers.id AS trigger_id,
           triggers.keyword AS trigger_keyword,
           triggers.match_type,
           triggers.is_active,
           triggers.created_at AS trigger_created_at,
           flows.id AS flow_id,
           flows.version AS flow_version,
           flows.status AS flow_status,
           flows.definition,
           flows.created_at AS flow_created_at
         FROM triggers
         JOIN flows ON flows.id = triggers.flow_id AND flows.version = triggers.flow_version
         WHERE triggers.bot_id = ? AND triggers.is_active = true AND flows.status = 'published'
         ORDER BY triggers.created_at ASC, triggers.id ASC
         LIMIT 1`,
        bot.id
      );

      if (existingWorkspace) {
        await client.query('COMMIT');
        return res.json({
          bot,
          flow: {
            id: existingWorkspace.flow_id,
            bot_id: bot.id,
            version: existingWorkspace.flow_version,
            status: existingWorkspace.flow_status,
            definition: existingWorkspace.definition,
            created_at: existingWorkspace.flow_created_at,
          },
          trigger: {
            id: existingWorkspace.trigger_id,
            bot_id: bot.id,
            flow_id: existingWorkspace.flow_id,
            flow_version: existingWorkspace.flow_version,
            keyword: existingWorkspace.trigger_keyword,
            match_type: existingWorkspace.match_type,
            is_active: existingWorkspace.is_active,
            created_at: existingWorkspace.trigger_created_at,
          },
        });
      }

      const definition: FlowDefinition = {
        nodes: [
          {
            id: 'demo-trigger-node',
            type: 'trigger',
            position: { x: 80, y: 100 },
            data: { keyword, matchType: 'contains' },
          },
          {
            id: 'demo-message-node',
            type: 'send_message',
            position: { x: 340, y: 100 },
            data: { text: replyText },
          },
        ],
        edges: [{ id: 'demo-trigger-to-message', source: 'demo-trigger-node', target: 'demo-message-node' }],
      };

      // The endpoint constructs the graph rather than accepting arbitrary
      // nodes, but keep the same publish invariant as the regular flow API.
      const validationErrors = validateFlowDefinition(definition);
      if (validationErrors.length > 0) throw new Error(`invalid demo flow: ${validationErrors.join('; ')}`);

      const flowId = randomUUID();
      const triggerId = randomUUID();
      const flow = await queryOne<{
        id: string;
        bot_id: string;
        version: number;
        definition: FlowDefinition;
        status: 'published';
        created_at: string;
      }>(
        client,
        `INSERT INTO flows (id, bot_id, version, definition, status)
         VALUES (?, ?, 1, ?, 'published')
         RETURNING *`,
        flowId,
        bot.id,
        JSON.stringify(definition)
      );
      const trigger = await queryOne<Trigger>(
        client,
        `INSERT INTO triggers (id, bot_id, flow_id, flow_version, keyword, match_type)
         VALUES (?, ?, ?, 1, ?, 'contains')
         RETURNING *`,
        triggerId,
        bot.id,
        flowId,
        keyword
      );

      await client.query('COMMIT');
      return res.status(201).json({ bot, flow, trigger });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }));

  // Persists one controlled demo conversation through the exact same flow
  // engine as a real webhook. It is intentionally separate from /test:
  // dry-run preview must stay analytics-clean, while this explicit action
  // exists to demonstrate the subscriber and timeline appearing in CRM.
  app.post('/api/bots/:botId/demo-interactions', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const messageText = typeof req.body?.messageText === 'string' ? req.body.messageText.trim() : '';
    if (!messageText) return res.status(400).json({ error: 'messageText is required' });

    const bot = await getBotForTenant(db, req.params.botId, tenantId);
    if (!bot) return res.status(404).json({ error: 'bot not found' });
    if (bot.external_account_id !== demoExternalAccountId(tenantId)) {
      return res.status(403).json({ error: 'demo interactions are only available for the tenant demo bot' });
    }

    const outcome = await runFlow(db, {
      tenantId,
      botId: bot.id,
      externalUserId: DEMO_EXTERNAL_USER_ID,
      messageText,
      isTest: false,
    });
    const subscriber = await queryOne<Subscriber>(
      db,
      `SELECT * FROM subscribers WHERE bot_id = ? AND external_user_id = ?`,
      bot.id,
      DEMO_EXTERNAL_USER_ID
    );

    // runFlow creates/fetches the persistent subscriber before trigger
    // matching. Reaching this branch without one would mean that invariant
    // regressed, so surface it as a server error rather than returning a
    // successful response that the CRM cannot follow.
    if (!subscriber) throw new Error('demo interaction completed without a persistent subscriber');

    res.json({ subscriberId: subscriber.id, outcome });
  }));

  // ---- Flows ---------------------------------------------------------------
  app.post('/api/bots/:botId/flows', asyncHandler(async (req, res) => {
    const bot = await getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const definition = req.body?.definition as FlowDefinition | undefined;
    if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
      return res.status(400).json({ error: 'definition with nodes[] and edges[] is required' });
    }

    const flowId = randomUUID();
    await exec(
      db,
      `INSERT INTO flows (id, bot_id, version, definition, status) VALUES (?, ?, 1, ?, 'draft')`,
      flowId,
      bot.id,
      JSON.stringify(definition)
    );

    res.status(201).json({ flow: { id: flowId, version: 1, status: 'draft' } });
  }));

  // Lists every flow (each version as its own row) for a bot — what the
  // canvas uses to show "your flows" instead of requiring the caller to
  // remember a flowId after creating it.
  app.get('/api/bots/:botId/flows', asyncHandler(async (req, res) => {
    const bot = await getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    // Newest first. The previous `ORDER BY id, version DESC` grouped
    // versions under their flow but ordered the groups by UUID, i.e.
    // arbitrarily — and the editor treats flows[0] as "the working
    // scenario", so with more than one flow it opened a random one and
    // announced it as the live one. created_at DESC makes that first
    // element actually mean something; id is the tiebreaker for rows
    // sharing a timestamp, so the order stays deterministic.
    const flows = await queryAll(
      db,
      `SELECT id, version, status, created_at FROM flows WHERE bot_id = ? ORDER BY created_at DESC, id DESC, version DESC`,
      bot.id
    );

    res.json({ flows });
  }));

  // Fetches one specific version's definition — needed to re-open an
  // existing draft/published flow for editing; without this the canvas
  // could only ever create new flows, never load one back in.
  app.get('/api/flows/:flowId/versions/:version', asyncHandler(async (req, res) => {
    const version = parsePositiveInt(req.params.version);
    // 404 rather than 400, matching what a well-formed but unknown version
    // already returns below — a malformed one is no more "found" than that,
    // and keeping the two indistinguishable gives nothing away.
    if (version === undefined) return res.status(404).json({ error: 'flow not found' });
    const row = await queryOne<{ id: string; version: number; definition: FlowDefinition; status: string; tenant_id: string }>(
      db,
      `SELECT flows.id, flows.version, flows.definition, flows.status, bots.tenant_id
       FROM flows JOIN bots ON flows.bot_id = bots.id
       WHERE flows.id = ? AND flows.version = ?`,
      req.params.flowId,
      version
    );

    if (!row || row.tenant_id !== res.locals.tenantId) return res.status(404).json({ error: 'flow not found' });

    res.json({ flow: { id: row.id, version: row.version, status: row.status, definition: row.definition } });
  }));

  // Publishing is where an invalid graph gets rejected — drafts can be
  // incomplete while being edited, but nothing incomplete can go live.
  app.post('/api/flows/:flowId/versions/:version/publish', asyncHandler(async (req, res) => {
    const version = parsePositiveInt(req.params.version);
    if (version === undefined) return res.status(404).json({ error: 'flow not found' });
    const row = await queryOne<{ definition: FlowDefinition; tenant_id: string }>(
      db,
      `SELECT flows.definition, bots.tenant_id
       FROM flows JOIN bots ON flows.bot_id = bots.id
       WHERE flows.id = ? AND flows.version = ?`,
      req.params.flowId,
      version
    );

    if (!row || row.tenant_id !== res.locals.tenantId) return res.status(404).json({ error: 'flow not found' });

    const errors = validateFlowDefinition(row.definition);
    if (errors.length > 0) return res.status(422).json({ errors });

    await exec(db, `UPDATE flows SET status = 'published' WHERE id = ? AND version = ?`, req.params.flowId, version);
    res.json({ flow: { id: req.params.flowId, version, status: 'published' } });
  }));

  // Adds a new draft version to an EXISTING flow (auto-incremented from
  // the current max version) — this is what makes rollback meaningful:
  // without a second version, there's nothing to roll back from.
  app.post('/api/flows/:flowId/versions', asyncHandler(async (req, res) => {
    const definition = req.body?.definition as FlowDefinition | undefined;
    if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
      return res.status(400).json({ error: 'definition with nodes[] and edges[] is required' });
    }

    const flowMeta = await queryOne<{ bot_id: string; tenant_id: string; maxversion: number }>(
      db,
      `SELECT flows.bot_id, bots.tenant_id, MAX(flows.version) as maxVersion
       FROM flows JOIN bots ON flows.bot_id = bots.id
       WHERE flows.id = ?
       GROUP BY flows.bot_id, bots.tenant_id`,
      req.params.flowId
    );

    if (!flowMeta || flowMeta.tenant_id !== res.locals.tenantId) return res.status(404).json({ error: 'flow not found' });

    const nextVersion = flowMeta.maxversion + 1;
    try {
      await exec(
        db,
        `INSERT INTO flows (id, bot_id, version, definition, status) VALUES (?, ?, ?, ?, 'draft')`,
        req.params.flowId,
        flowMeta.bot_id,
        nextVersion,
        JSON.stringify(definition)
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Two concurrent "add a version" calls computed the same
        // maxVersion+1 and raced for the flows(id, version) primary key
        // (rare — this editor has one save button, not concurrent
        // callers) — ask the loser to recompute against the now-current
        // max rather than surfacing a bare 500.
        return res.status(409).json({ error: 'version already created by a concurrent request, retry' });
      }
      throw err;
    }

    res.status(201).json({ flow: { id: req.params.flowId, version: nextVersion, status: 'draft' } });
  }));

  // ---- Triggers --------------------------------------------------------
  app.post('/api/bots/:botId/triggers', asyncHandler(async (req, res) => {
    const bot = await getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const { keyword, matchType, flowId, flowVersion } = req.body ?? {};
    if (!keyword || !flowId || !flowVersion) {
      return res.status(400).json({ error: 'keyword, flowId and flowVersion are required' });
    }

    const flow = await queryOne<{ status: string }>(db, `SELECT status FROM flows WHERE id = ? AND version = ? AND bot_id = ?`, flowId, flowVersion, bot.id);

    if (!flow) return res.status(404).json({ error: 'flow not found on this bot' });
    if (flow.status !== 'published') {
      return res.status(422).json({ error: 'cannot bind a trigger to a flow that is not published' });
    }

    // Two active triggers on the same bot racing for the same keyword is
    // not a valid state — matchTrigger() would silently pick whichever one
    // was created first and the other would never fire. No draft/active
    // split exists on triggers (every row is_active=true, see schema.sql),
    // so this checks against all of the bot's existing triggers, not a
    // "live" subset — comparison is normalized the same way matching is
    // (trim + lowercase), so "Цена" and " цена " collide too.
    const existingTriggers = await getActiveTriggersForBot(db, bot.id);
    const normalizedIncoming = normalizeKeyword(keyword);
    if (existingTriggers.some((t) => normalizeKeyword(t.keyword) === normalizedIncoming)) {
      return res.status(409).json({ error: 'a trigger with this keyword already exists for this bot' });
    }

    // The check above is a fast pre-check for the common (non-racing) case
    // — same two-layer shape as flow_runs' dedup (see triggerMatcher.ts's
    // comment on hasRunToday). It is NOT the source of truth under
    // concurrency: two requests can both pass it before either INSERT
    // lands. idx_triggers_bot_keyword_unique (schema.sql) is the real
    // guarantee; this catch is what makes the loser of that race get a
    // clean 409 instead of an unhandled 500.
    const triggerId = randomUUID();
    try {
      await exec(
        db,
        `INSERT INTO triggers (id, bot_id, flow_id, flow_version, keyword, match_type) VALUES (?, ?, ?, ?, ?, ?)`,
        triggerId,
        bot.id,
        flowId,
        flowVersion,
        keyword,
        matchType ?? 'contains'
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'a trigger with this keyword already exists for this bot' });
      }
      throw err;
    }

    res.status(201).json({
      trigger: { id: triggerId, bot_id: bot.id, flow_id: flowId, flow_version: flowVersion, keyword, match_type: matchType ?? 'contains', is_active: true },
    });
  }));

  // Points an existing trigger back at an earlier version of the same
  // flow. Doesn't touch flow rows or other triggers on the same flow —
  // triggers are bound per-version by design (see schema.sql), so rolling
  // one back can't silently change what any other trigger runs.
  app.post('/api/triggers/:triggerId/rollback', asyncHandler(async (req, res) => {
    const trigger = await queryOne<Trigger & { bot_tenant_id: string }>(
      db,
      `SELECT triggers.*, bots.tenant_id as bot_tenant_id
       FROM triggers JOIN bots ON triggers.bot_id = bots.id
       WHERE triggers.id = ?`,
      req.params.triggerId
    );

    if (!trigger || trigger.bot_tenant_id !== res.locals.tenantId) return res.status(404).json({ error: 'trigger not found' });

    // parsePositiveInt, not Number: 'Infinity' and '1.5' passed the old
    // truthiness check and then failed inside Postgres as a 500.
    const toVersion = parsePositiveInt(req.body?.toVersion);
    if (toVersion === undefined) return res.status(400).json({ error: 'toVersion is required' });

    const targetFlow = await queryOne<{ status: string }>(db, `SELECT status FROM flows WHERE id = ? AND version = ?`, trigger.flow_id, toVersion);

    if (!targetFlow) return res.status(404).json({ error: 'target flow version not found' });
    // Only ever-published versions are valid rollback targets — an
    // untested draft was never live, so "rolling back" to it would mean
    // something different (promoting unreviewed content), not a revert.
    if (targetFlow.status !== 'published') {
      return res.status(422).json({ error: 'can only roll back to a version that was published' });
    }

    await exec(db, `UPDATE triggers SET flow_version = ? WHERE id = ?`, toVersion, trigger.id);
    res.json({ trigger: { id: trigger.id, flow_id: trigger.flow_id, flow_version: toVersion } });
  }));

  // ---- Test mode ---------------------------------------------------------
  app.post('/api/bots/:botId/test', asyncHandler(async (req, res) => {
    const bot = await getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const { externalUserId, messageText } = req.body ?? {};
    if (!externalUserId || !messageText) {
      return res.status(400).json({ error: 'externalUserId and messageText are required' });
    }

    const outcome = await runFlow(db, {
      tenantId: res.locals.tenantId as string,
      botId: bot.id,
      externalUserId,
      messageText,
      isTest: true,
    });

    res.json({ outcome });
  }));

  // ---- Dashboard -----------------------------------------------------------
  app.get('/api/bots/:botId/dashboard', asyncHandler(async (req, res) => {
    const bot = await getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    // None of these three depends on another's result — run them
    // concurrently so the endpoint pays the max of the three round trips
    // to Postgres instead of their sum.
    const [subscriberCountRow, runsByStatus, recentRuns] = await Promise.all([
      queryOne<{ n: number }>(db, `SELECT COUNT(*) as n FROM subscribers WHERE bot_id = ?`, bot.id),
      queryAll<{ status: string; n: number }>(db, `SELECT status, COUNT(*) as n FROM flow_runs WHERE bot_id = ? GROUP BY status`, bot.id),
      queryAll(
        db,
        `SELECT flow_runs.id, triggers.keyword, flow_runs.status, flow_runs.failure_reason, flow_runs.started_at
         FROM flow_runs JOIN triggers ON flow_runs.trigger_id = triggers.id
         WHERE flow_runs.bot_id = ?
         ORDER BY flow_runs.started_at DESC, flow_runs.seq DESC
         LIMIT 10`,
        bot.id
      ),
    ]);

    res.json({ subscriberCount: subscriberCountRow!.n, runsByStatus, recentRuns });
  }));

  // ---- Module 2: CRM and audience database -------------------------------

  // List + filter — the "table/Kanban of leads" and "filters by segment"
  // from the ТЗ both read from this one endpoint; a segment is just this
  // query with a tag filter applied, not a stored entity.
  app.get('/api/bots/:botId/subscribers', asyncHandler(async (req, res) => {
    const bot = await getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const { tag, leadStatus } = req.query as { tag?: string; leadStatus?: string };
    const conditions = ['bot_id = ?'];
    const params: unknown[] = [bot.id];

    if (tag) {
      // tags.tenant_id as well as the name: tag names are only unique per
      // tenant, so matching on the name alone meant this subquery could
      // resolve another tenant's tag id. No data leaked (the outer query is
      // already restricted to this tenant's bot), but the filter would
      // match or miss rows for reasons outside the caller's own data.
      conditions.push(
        `id IN (SELECT subscriber_id FROM subscriber_tags JOIN tags ON subscriber_tags.tag_id = tags.id WHERE tags.name = ? AND tags.tenant_id = ?)`
      );
      params.push(tag, res.locals.tenantId);
    }
    if (leadStatus) {
      conditions.push('lead_status = ?');
      params.push(leadStatus);
    }

    const subscribers = await queryAll<Subscriber>(
      db,
      `SELECT * FROM subscribers WHERE ${conditions.join(' AND ')} ORDER BY last_interacted_at DESC, seq DESC`,
      ...params
    );

    const tagsBySubscriber = await tagsForSubscribers(db, subscribers.map((s) => s.id), res.locals.tenantId as string);
    res.json({ subscribers: subscribers.map((s) => ({ ...s, tags: tagsBySubscriber[s.id] ?? [] })) });
  }));

  app.get('/api/subscribers/:id', asyncHandler(async (req, res) => {
    const subscriber = await getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const tags = (await tagsForSubscribers(db, [subscriber.id], res.locals.tenantId as string))[subscriber.id] ?? [];
    res.json({ subscriber: { ...subscriber, tags } });
  }));

  app.patch('/api/subscribers/:id/lead-status', asyncHandler(async (req, res) => {
    const subscriber = await getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const { leadStatus } = req.body ?? {};
    if (!['new', 'in_progress', 'client'].includes(leadStatus)) {
      return res.status(400).json({ error: 'leadStatus must be one of: new, in_progress, client' });
    }

    await exec(db, `UPDATE subscribers SET lead_status = ? WHERE id = ?`, leadStatus, subscriber.id);
    res.json({ subscriber: { ...subscriber, lead_status: leadStatus } });
  }));

  // The contact profile timeline — every inbound message (matched or not)
  // plus every outbound send, in order. This is what flowEngine's
  // logMessage calls (added for Module 2) exist to make possible.
  app.get('/api/subscribers/:id/messages', asyncHandler(async (req, res) => {
    const subscriber = await getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const messages = await queryAll(
      // seq tiebreaker: two messages logged within the same millisecond
      // would otherwise sort in an unstable order relative to each other.
      db,
      `SELECT direction, content, created_at FROM messages WHERE subscriber_id = ? ORDER BY created_at ASC, seq ASC`,
      subscriber.id
    );

    res.json({ messages });
  }));

  app.get('/api/subscribers/:id/notes', asyncHandler(async (req, res) => {
    const subscriber = await getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const notes = await queryAll(db, `SELECT id, body, created_at FROM notes WHERE subscriber_id = ? ORDER BY created_at DESC, seq DESC`, subscriber.id);
    res.json({ notes });
  }));

  app.post('/api/subscribers/:id/notes', asyncHandler(async (req, res) => {
    const subscriber = await getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const { body } = req.body ?? {};
    if (!body || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'body is required' });
    }

    const id = randomUUID();
    await exec(db, `INSERT INTO notes (id, subscriber_id, tenant_id, body) VALUES (?, ?, ?, ?)`, id, subscriber.id, subscriber.tenant_id, body);
    res.status(201).json({ note: { id, subscriber_id: subscriber.id, body } });
  }));

  app.get('/api/bots/:botId/tags', asyncHandler(async (req, res) => {
    const bot = await getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const tags = await queryAll(db, `SELECT id, name FROM tags WHERE tenant_id = ? ORDER BY name`, res.locals.tenantId);
    res.json({ tags });
  }));

  // "Быстрое добавление тега прямо из чата" — one call, creates the tag
  // if it doesn't exist yet rather than requiring a separate create-tag
  // step first.
  app.post('/api/subscribers/:id/tags', asyncHandler(async (req, res) => {
    const subscriber = await getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });

    let tag = await queryOne<{ id: string; name: string }>(db, `SELECT id, name FROM tags WHERE tenant_id = ? AND name = ?`, subscriber.tenant_id, name);

    if (!tag) {
      const id = randomUUID();
      try {
        await exec(db, `INSERT INTO tags (id, tenant_id, name) VALUES (?, ?, ?)`, id, subscriber.tenant_id, name);
        tag = { id, name };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Lost the race to a concurrent create of the same tag name
        // (tags has UNIQUE(tenant_id, name)) — the winner's row already
        // exists, so use it instead of failing a harmless race.
        tag = await queryOne<{ id: string; name: string }>(db, `SELECT id, name FROM tags WHERE tenant_id = ? AND name = ?`, subscriber.tenant_id, name);
        if (!tag) throw err;
      }
    }

    await exec(db, `INSERT INTO subscriber_tags (subscriber_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, subscriber.id, tag.id);
    res.status(201).json({ tag });
  }));

  app.delete('/api/subscribers/:id/tags/:tagId', asyncHandler(async (req, res) => {
    const subscriber = await getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    await exec(db, `DELETE FROM subscriber_tags WHERE subscriber_id = ? AND tag_id = ?`, subscriber.id, req.params.tagId);
    res.status(204).send();
  }));

  // CLAUDE.md's security section requires a right to erasure under
  // Kazakhstan's personal data law, and a CRM contact is the one place this
  // product holds personal data. There was no way to delete one at all.
  //
  // The rows are removed explicitly, child-first, inside one transaction
  // rather than leaning on ON DELETE CASCADE: schema.sql has no cascades,
  // and since it is applied once to an empty database (no migration
  // framework yet — see the audit note in CLAUDE.md), adding them would only
  // affect newly created databases and silently leave every existing
  // deployment unable to erase anything. Doing it in application code works
  // identically on both. All of it is one transaction so a failure halfway
  // cannot leave a contact half-erased, which would be worse than not
  // having started.
  app.delete('/api/subscribers/:id', asyncHandler(async (req, res) => {
    const subscriber = await getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // mock_sent_messages references flow_runs, so it goes before them.
      await exec(client, `DELETE FROM mock_sent_messages WHERE subscriber_id = ?`, subscriber.id);
      await exec(client, `DELETE FROM flow_runs WHERE subscriber_id = ?`, subscriber.id);
      await exec(client, `DELETE FROM messages WHERE subscriber_id = ?`, subscriber.id);
      await exec(client, `DELETE FROM notes WHERE subscriber_id = ?`, subscriber.id);
      await exec(client, `DELETE FROM subscriber_tags WHERE subscriber_id = ?`, subscriber.id);
      // Tags themselves are tenant-level vocabulary, not personal data, so
      // they stay — only this contact's assignment to them is removed.
      await exec(client, `DELETE FROM subscribers WHERE id = ? AND tenant_id = ?`, subscriber.id, res.locals.tenantId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(204).send();
  }));

  // ---- Module 3: Reel analysis and script adaptation (mocked) ------------
  // "Вставьте ссылку" -> analyzeReelMock stands in for yt-dlp + Whisper +
  // an LLM call. Only this function's internals change when the real
  // pipeline replaces it; the request/response shape here is what the
  // real version will also expose.
  app.post('/api/reel-analyses', asyncHandler(async (req, res) => {
    const sourceUrl = typeof req.body?.sourceUrl === 'string' ? req.body.sourceUrl.trim() : '';
    if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl is required' });

    const fields = analyzeReelMock(sourceUrl);
    const id = randomUUID();
    await exec(
      db,
      `INSERT INTO reel_analyses (id, tenant_id, source_url, hook, duration_seconds, on_screen_text, structure)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      res.locals.tenantId,
      fields.source_url,
      fields.hook,
      fields.duration_seconds,
      fields.on_screen_text,
      // pg serializes a JS array parameter as a Postgres array literal, not
      // JSON — must stringify explicitly for a jsonb column (see db.ts's
      // query helpers: objects get auto-JSON'd by pg, arrays don't).
      JSON.stringify(fields.structure)
    );

    const analysis = (await getAnalysisForTenant(db, id, res.locals.tenantId as string))!;
    res.status(201).json({ analysis });
  }));

  // The "library" from the ТЗ.
  app.get('/api/reel-analyses', asyncHandler(async (req, res) => {
    const analyses = await queryAll<ReelAnalysis>(db, `SELECT * FROM reel_analyses WHERE tenant_id = ? ORDER BY created_at DESC, seq DESC`, res.locals.tenantId);
    res.json({ analyses });
  }));

  app.get('/api/reel-analyses/:id', asyncHandler(async (req, res) => {
    const analysis = await getAnalysisForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });

    res.json({ analysis });
  }));

  app.post('/api/reel-analyses/:id/scripts', asyncHandler(async (req, res) => {
    const analysis = await getAnalysisForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });

    const niche = typeof req.body?.niche === 'string' ? req.body.niche.trim() : '';
    if (!niche) return res.status(400).json({ error: 'niche is required' });

    const scriptText = generateScriptMock(analysis, niche);
    const id = randomUUID();
    await exec(db, `INSERT INTO generated_scripts (id, tenant_id, analysis_id, niche, script_text) VALUES (?, ?, ?, ?, ?)`, id, res.locals.tenantId, analysis.id, niche, scriptText);

    res.status(201).json({ script: { id, tenant_id: res.locals.tenantId, analysis_id: analysis.id, niche, script_text: scriptText } });
  }));

  app.get('/api/reel-analyses/:id/scripts', asyncHandler(async (req, res) => {
    const analysis = await getAnalysisForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });

    const scripts = await queryAll<GeneratedScript>(db, `SELECT * FROM generated_scripts WHERE analysis_id = ? ORDER BY created_at DESC, seq DESC`, analysis.id);
    res.json({ scripts });
  }));

  // "Поиск по тегам ниши" (ТЗ) across the whole library, not just one analysis.
  app.get('/api/scripts', asyncHandler(async (req, res) => {
    const niche = typeof req.query.niche === 'string' ? req.query.niche : undefined;
    const scripts = niche
      ? await queryAll<GeneratedScript>(db, `SELECT * FROM generated_scripts WHERE tenant_id = ? AND niche = ? ORDER BY created_at DESC, seq DESC`, res.locals.tenantId, niche)
      : await queryAll<GeneratedScript>(db, `SELECT * FROM generated_scripts WHERE tenant_id = ? ORDER BY created_at DESC, seq DESC`, res.locals.tenantId);

    res.json({ scripts });
  }));

  // ---- Module 4: Carousel generation (mocked LLM text) --------------------

  app.post('/api/brand-presets', asyncHandler(async (req, res) => {
    const { name, fontFamily, primaryColor, secondaryColor, logoUrl } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const id = randomUUID();
    const fields = {
      font_family: fontFamily ?? 'system-ui',
      primary_color: primaryColor ?? '#111111',
      secondary_color: secondaryColor ?? '#ffffff',
      logo_url: logoUrl ?? null,
    };
    await exec(
      db,
      `INSERT INTO brand_presets (id, tenant_id, name, font_family, primary_color, secondary_color, logo_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      res.locals.tenantId,
      name,
      fields.font_family,
      fields.primary_color,
      fields.secondary_color,
      fields.logo_url
    );

    res.status(201).json({ preset: { id, tenant_id: res.locals.tenantId, name, ...fields } });
  }));

  app.get('/api/brand-presets', asyncHandler(async (req, res) => {
    const presets = await queryAll(db, `SELECT * FROM brand_presets WHERE tenant_id = ? ORDER BY name`, res.locals.tenantId);
    res.json({ presets });
  }));

  // "Промпт → готовая карусель" — generateCarouselSlides calls OpenAI when
  // OPENAI_API_KEY is set, falling back to the deterministic mock otherwise
  // (missing key, network error, malformed response); everything else
  // (slide storage, editing, listing) is real either way.
  app.post('/api/carousels', asyncHandler(async (req, res) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const presetId = req.body?.presetId ?? null;
    if (presetId) {
      const preset = await queryOne(db, `SELECT id FROM brand_presets WHERE id = ? AND tenant_id = ?`, presetId, res.locals.tenantId);
      if (!preset) return res.status(404).json({ error: 'preset not found' });
    }

    const carouselId = randomUUID();
    await exec(db, `INSERT INTO carousels (id, tenant_id, prompt, preset_id) VALUES (?, ?, ?, ?)`, carouselId, res.locals.tenantId, prompt, presetId);

    // One multi-row INSERT, not an awaited-per-slide loop: each slide is
    // an independent Postgres round-trip now (unlike the old synchronous
    // better-sqlite3 version, which committed the whole batch on one
    // in-process call), so a sequential loop both serializes N round-trips
    // and lets a concurrent reader observe a carousel with only some of
    // its slides if the request fails partway through.
    const slides = await generateCarouselSlides(prompt);
    const slideParams = slides.flatMap((slide, i) => [randomUUID(), carouselId, res.locals.tenantId, i, slide.headline, slide.body]);
    const valuesSql = slides.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    await exec(db, `INSERT INTO carousel_slides (id, carousel_id, tenant_id, position, headline, body) VALUES ${valuesSql}`, ...slideParams);

    const carousel = (await getCarouselForTenant(db, carouselId, res.locals.tenantId as string))!;
    res.status(201).json({ carousel, slides: await getSlidesForCarousel(db, carouselId) });
  }));

  app.get('/api/carousels', asyncHandler(async (req, res) => {
    const carousels = await queryAll(db, `SELECT * FROM carousels WHERE tenant_id = ? ORDER BY created_at DESC, seq DESC`, res.locals.tenantId);
    res.json({ carousels });
  }));

  app.get('/api/carousels/:id', asyncHandler(async (req, res) => {
    const carousel = await getCarouselForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!carousel) return res.status(404).json({ error: 'carousel not found' });

    res.json({ carousel, slides: await getSlidesForCarousel(db, carousel.id) });
  }));

  // Persists manual edits made in the Fabric.js editor (ТЗ: "ручное
  // редактирование слайдов после генерации"). Only text content is
  // persisted, not exact dragged element positions — a documented MVP
  // simplification, not an oversight.
  app.patch('/api/carousels/:carouselId/slides/:slideId', asyncHandler(async (req, res) => {
    const carousel = await getCarouselForTenant(db, req.params.carouselId, res.locals.tenantId as string);
    if (!carousel) return res.status(404).json({ error: 'carousel not found' });

    const slide = await queryOne<CarouselSlide>(db, `SELECT * FROM carousel_slides WHERE id = ? AND carousel_id = ?`, req.params.slideId, carousel.id);
    if (!slide) return res.status(404).json({ error: 'slide not found' });

    const headline = typeof req.body?.headline === 'string' ? req.body.headline : slide.headline;
    const body = typeof req.body?.body === 'string' ? req.body.body : slide.body;

    await exec(db, `UPDATE carousel_slides SET headline = ?, body = ? WHERE id = ?`, headline, body, slide.id);
    res.json({ slide: { ...slide, headline, body } });
  }));

  // ---- Module 5: Cross-platform autoposting (mocked) ---------------------

  const PLATFORMS = ['instagram', 'tiktok', 'youtube_shorts'];

  app.post('/api/scheduled-posts', asyncHandler(async (req, res) => {
    const { platform, caption, scheduledAt, requiresApproval } = req.body ?? {};
    if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: `platform must be one of: ${PLATFORMS.join(', ')}` });
    if (!caption || typeof caption !== 'string') return res.status(400).json({ error: 'caption is required' });
    if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) return res.status(400).json({ error: 'scheduledAt must be a valid date' });

    const id = randomUUID();
    const status = requiresApproval ? 'pending_approval' : 'scheduled';
    await exec(
      db,
      `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, requires_approval, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      res.locals.tenantId,
      platform,
      caption,
      new Date(scheduledAt).toISOString(),
      Boolean(requiresApproval),
      status
    );

    if (status === 'pending_approval') {
      await notify(db, res.locals.tenantId as string, 'post_pending_approval', `Пост в ${platform} ждёт согласования`, id);
    }

    // toPublicScheduledPost, not the raw row: the background publisher
    // timer (or a concurrent /process-due call) can claim this row to
    // 'publishing' between the INSERT above and this read-back, and
    // 'publishing' is an internal transient state every other endpoint
    // in this file already hides from API consumers.
    const created = await getScheduledPostForTenant(db, id, res.locals.tenantId as string);
    res.status(201).json({ post: created && toPublicScheduledPost(created) });
  }));

  // The calendar/queue screen from the ТЗ reads from here, filtered by
  // status and/or date range.
  app.get('/api/scheduled-posts', asyncHandler(async (req, res) => {
    const { status, from, to } = req.query as { status?: string; from?: string; to?: string };
    const conditions = ['tenant_id = ?'];
    const params: unknown[] = [res.locals.tenantId];

    if (status === 'scheduled') {
      // 'publishing' is the internal claim state a row passes through while
      // the background publisher is mid-send — toPublicScheduledPost maps
      // it back to 'scheduled' for every other endpoint, so a filter on the
      // raw column must match both or it can drop a post mid-publish from
      // the calendar/queue view for the seconds the claim is held.
      conditions.push("status IN ('scheduled', 'publishing')");
    } else if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (from) {
      conditions.push('scheduled_at >= ?');
      params.push(new Date(from).toISOString());
    }
    if (to) {
      conditions.push('scheduled_at <= ?');
      params.push(new Date(to).toISOString());
    }

    const posts = await queryAll<ScheduledPost>(db, `SELECT * FROM scheduled_posts WHERE ${conditions.join(' AND ')} ORDER BY scheduled_at ASC, seq ASC`, ...params);

    res.json({ posts: posts.map(toPublicScheduledPost) });
  }));

  app.get('/api/scheduled-posts/:id', asyncHandler(async (req, res) => {
    const post = await getScheduledPostForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!post) return res.status(404).json({ error: 'post not found' });
    res.json({ post: toPublicScheduledPost(post) });
  }));

  // Approval workflow is optional per the ТЗ — only posts created with
  // requiresApproval land in pending_approval in the first place.
  app.post('/api/scheduled-posts/:id/approve', asyncHandler(async (req, res) => {
    const post = await getScheduledPostForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!post) return res.status(404).json({ error: 'post not found' });
    if (post.status !== 'pending_approval') return res.status(422).json({ error: 'post is not pending approval' });

    // WHERE status = 'pending_approval' guards this the same way
    // publisher.ts's claim-UPDATE does — the check above is stale by the
    // time this runs (another await point another request can land in),
    // so a near-simultaneous approve+reject on the same post must not
    // both be able to write; whichever call's WHERE no longer matches
    // gets nothing back instead of silently overwriting the other's result.
    const updated = await queryOne<{ id: string }>(
      db,
      `UPDATE scheduled_posts SET status = 'scheduled' WHERE id = ? AND status = 'pending_approval' RETURNING id`,
      post.id
    );
    if (!updated) return res.status(409).json({ error: 'post was already approved or rejected by a concurrent request' });

    const fresh = await getScheduledPostForTenant(db, post.id, res.locals.tenantId as string);
    res.json({ post: fresh && toPublicScheduledPost(fresh) });
  }));

  app.post('/api/scheduled-posts/:id/reject', asyncHandler(async (req, res) => {
    const post = await getScheduledPostForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!post) return res.status(404).json({ error: 'post not found' });
    if (post.status !== 'pending_approval') return res.status(422).json({ error: 'post is not pending approval' });

    const updated = await queryOne<{ id: string }>(
      db,
      `UPDATE scheduled_posts SET status = 'rejected' WHERE id = ? AND status = 'pending_approval' RETURNING id`,
      post.id
    );
    if (!updated) return res.status(409).json({ error: 'post was already approved or rejected by a concurrent request' });

    const fresh = await getScheduledPostForTenant(db, post.id, res.locals.tenantId as string);
    res.json({ post: fresh && toPublicScheduledPost(fresh) });
  }));

  // Manual trigger for the polling publisher — there's no real queue to
  // fire an event, so this is what lets a demo/test see a due post
  // actually "publish" without waiting for the timer in server.ts.
  // Scoped to the calling tenant — see publishDuePosts' own comment: the
  // unscoped form here let any tenant publish every other tenant's due
  // posts. The server-side timer in server.ts keeps the unscoped sweep.
  app.post('/api/scheduled-posts/process-due', asyncHandler(async (_req, res) => {
    res.json(await publishDuePosts(db, new Date(), res.locals.tenantId as string));
  }));

  // ---- Module 6: Content plan from CRM + Module 3 (the real differentiator) --
  // No new tables — computeContentRecommendations reads Module 2's tags/
  // subscribers and Module 3's generated_scripts directly.
  app.get('/api/content-recommendations', asyncHandler(async (req, res) => {
    const all = await computeContentRecommendations(db, res.locals.tenantId as string);
    const segment = typeof req.query.segment === 'string' ? req.query.segment : undefined;
    const recommendations = segment ? all.filter((r) => r.segment.toLowerCase() === segment.toLowerCase()) : all;
    res.json({ recommendations });
  }));

  // ---- Module 8: Video editing, Levels 1-2 (mocked Shotstack/Creatomate) --

  const VIDEO_TEMPLATES: VideoTemplate[] = ['auto_crop_916', 'template_with_transitions', 'ai_smart_cut'];

  // Level 3 needs the actual file, which the Level 1-2 presets never did
  // (they take a URL string). The browser uploads straight to object storage
  // with this presigned URL — the API never sees the bytes, because proxying
  // a few hundred megabytes of video through an Express process on a small
  // instance is what takes the whole API down.
  app.post('/api/video-uploads', asyncHandler(async (req, res) => {
    const storage = storageConfigFromEnv();
    if (!storage && !localMedia) return res.status(503).json({ error: 'storage_not_configured' });

    const contentType = typeof req.body?.contentType === 'string' ? req.body.contentType : '';
    if (!UPLOAD_CONTENT_TYPES.includes(contentType)) {
      return res.status(400).json({ error: `contentType must be one of: ${UPLOAD_CONTENT_TYPES.join(', ')}` });
    }

    // The key is derived server-side and namespaced by tenant; a
    // client-supplied key would let one tenant write into another's prefix,
    // and a moment later read it back as a "source" of their own job.
    const objectKey = `tenants/${res.locals.tenantId}/sources/${randomUUID()}.${UPLOAD_EXTENSIONS[contentType]}`;
    // R2 wins whenever it is configured — the local store is the fallback that
    // makes the feature runnable before a bucket exists, not a preference.
    const uploadUrl = storage
      ? presign(storage, { method: 'PUT', key: objectKey, contentType, expiresInSec: UPLOAD_URL_TTL_SEC })
      : signLocalUrl(localMedia!, 'PUT', objectKey, UPLOAD_URL_TTL_SEC);

    res.status(201).json({
      objectKey,
      uploadUrl,
      // With R2 the browser must send exactly this header on the PUT — it is
      // part of what was signed, so anything else is rejected by the storage.
      contentType,
      expiresInSec: UPLOAD_URL_TTL_SEC,
      storage: storage ? 'r2' : 'local',
    });
  }));

  app.post('/api/video-edit-jobs', asyncHandler(async (req, res) => {
    const template = req.body?.template;
    if (!VIDEO_TEMPLATES.includes(template)) return res.status(400).json({ error: `template must be one of: ${VIDEO_TEMPLATES.join(', ')}` });

    const tenantId = res.locals.tenantId as string;

    if (template === 'ai_smart_cut') {
      const sourceObjectKey = typeof req.body?.sourceObjectKey === 'string' ? req.body.sourceObjectKey.trim() : '';
      if (!sourceObjectKey) return res.status(400).json({ error: 'sourceObjectKey is required for ai_smart_cut' });
      // Multi-tenancy isolation (CLAUDE.md): the key came back from this
      // tenant's own upload request, so it must still carry their prefix.
      // Without this check a tenant could name any key in the bucket and have
      // the worker render — and hand back — another tenant's private footage.
      if (!sourceObjectKey.startsWith(`tenants/${tenantId}/sources/`)) {
        return res.status(403).json({ error: 'source_object_key_not_owned' });
      }

      // Captions are burned into the pixels and cannot be removed afterwards,
      // so this defaults to on (it is the point of the Level-3 output) but
      // stays explicitly switchable per job.
      const subtitles = req.body?.subtitles === undefined ? true : req.body.subtitles === true;
      // Opt-in, unlike subtitles: stripping ambience is destructive and the
      // caller has to ask for it.
      // 'auto' unless the caller insists: the system measures the recording
      // and decides, which is the whole point of not putting this on the user.
      const denoiseMode = ['on', 'off'].includes(req.body?.denoiseMode) ? req.body.denoiseMode : 'auto';
      // Opt-in review: the pipeline stops after captions are generated and
      // waits. Worth it on languages the models only approximate, wasted
      // friction on the ones they get right.
      // Same shape as denoise: measured decision by default, override on request.
      const reviewMode = ['always', 'never'].includes(req.body?.reviewMode) ? req.body.reviewMode : 'auto';
      // An unrecognised id falls back rather than failing: it can only come
      // from a stale client, and a caption look is not worth a 400.
      const subtitlePreset = isSubtitlePresetId(req.body?.subtitlePreset) ? req.body.subtitlePreset : DEFAULT_SUBTITLE_PRESET;
      // Same fallback, and the default is 'auto' — the absence of an override,
      // which leaves the preset's own placement alone.
      const subtitlePosition = isSubtitlePositionId(req.body?.subtitlePosition)
        ? req.body.subtitlePosition
        : DEFAULT_SUBTITLE_POSITION;
      // Opt-in: the most destructive pass in the pipeline, and on a noisy
      // recording it finds nothing anyway.
      const removeBreaths = req.body?.removeBreaths === true;
      // Stored already cleaned, so the renderer is not the last line of defence
      // against a brace that would break out of an ASS override block. Empty
      // becomes NULL rather than '': no headline and a headline of nothing are
      // the same thing, and one of the two spellings would otherwise reserve a
      // band for blank space.
      const headline =
        typeof req.body?.headline === 'string' ? sanitizeHeadline(req.body.headline) || null : null;

      const id = randomUUID();
      await exec(
        db,
        `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, source_object_key, subtitles, denoise_mode, review_mode, subtitle_preset, subtitle_position, headline, remove_breaths) VALUES (?, ?, ?, ?, 'smart_cut', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        tenantId,
        sourceObjectKey,
        template,
        sourceObjectKey,
        subtitles,
        denoiseMode,
        reviewMode,
        subtitlePreset,
        subtitlePosition,
        headline,
        removeBreaths
      );
      return res.status(201).json({ job: await getVideoJobForTenant(db, id, tenantId) });
    }

    const sourceVideoUrl = typeof req.body?.sourceVideoUrl === 'string' ? req.body.sourceVideoUrl.trim() : '';
    if (!sourceVideoUrl) return res.status(400).json({ error: 'sourceVideoUrl is required' });

    const id = randomUUID();
    await exec(db, `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template) VALUES (?, ?, ?, ?)`, id, tenantId, sourceVideoUrl, template);

    res.status(201).json({ job: await getVideoJobForTenant(db, id, tenantId) });
  }));

  // A finished render, as a link that saves instead of playing. Falls back to
  // the inline URL where there is nothing to sign: the mock Level-1/2 pipeline
  // keeps no object key, and local development serves media from this same
  // origin, where the anchor's own `download` attribute already works.
  function downloadUrlForJob(objectKey: string | null, jobId: string, outputUrl: string | null): string | null {
    if (!outputUrl) return null;
    const storage = storageConfigFromEnv();
    if (!storage || !objectKey) return outputUrl;
    return downloadUrlFor(storage, objectKey, `sonar-${jobId.slice(0, 8)}.mp4`);
  }

  app.get('/api/video-edit-jobs', asyncHandler(async (req, res) => {
    // artifacts minus the transcript: the frontend polls this every 2s while
    // anything renders, and a 20-minute clip's word list is tens of kilobytes
    // that no screen displays. The single-job GET below still returns it in
    // full for anything that needs the detail.
    const jobs = await queryAll(
      db,
      `SELECT id, seq, tenant_id, source_video_url, template, status, progress_percent,
              output_url, poster_url, failure_reason, created_at, completed_at,
              pipeline, stage, subtitles, denoise_mode, review_mode, claimed_at,
              output_object_key,
              artifacts - 'transcript' AS artifacts
       FROM video_edit_jobs WHERE tenant_id = ? ORDER BY created_at DESC, seq DESC`,
      res.locals.tenantId
    );

    // Derived here rather than sent as a raw lease timestamp: the frontend has
    // no business knowing how long a claim lasts, and a second copy of that
    // constant would drift from the one the worker actually uses.
    const now = new Date();
    // Asked once per list, not per job: it is a fact about the fleet, and the
    // screen needs it only to choose between "waiting its turn" and "waiting
    // for a worker that is not running".
    const workerOnline = await isWorkerOnline(db, SMART_CUT_WORKER, now);
    res.json({
      worker_online: workerOnline,
      jobs: (
        jobs as Array<Record<string, unknown> & { id: string; status: string; claimed_at: string | null; output_url: string | null; output_object_key: string | null }>
      ).map(({ claimed_at, output_object_key, ...job }) => ({
        ...job,
        awaiting_worker: isAwaitingWorker({ status: job.status, claimed_at }, now),
        // The object key itself stays server-side; what leaves is a link that
        // already carries the filename the browser should save it under.
        download_url: downloadUrlForJob(output_object_key, job.id, job.output_url),
      })),
    });
  }));

  // The frontend polls this while a job is `processing` to drive the
  // progress bar the ТЗ calls for.
  app.get('/api/video-edit-jobs/:id', asyncHandler(async (req, res) => {
    const job = await getVideoJobForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ job });
  }));

  // Manual trigger for the polling renderer — same reasoning as
  // /api/scheduled-posts/process-due in Module 5: no real queue to fire
  // an event, so this lets a demo see progress advance without waiting
  // for the timer in server.ts.
  // Tenant-scoped for the same reason as process-due above.
  // Returns the caption lines a paused job is waiting on, and accepts the
  // corrected ones. PUT rather than PATCH: the client sends the whole list
  // back, because lines can be merged or emptied, not just retyped.
  app.put('/api/video-edit-jobs/:id/captions', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const job = await queryOne<VideoEditJob>(
      db,
      `SELECT * FROM video_edit_jobs WHERE id = ? AND tenant_id = ?`,
      req.params.id,
      tenantId
    );
    if (!job) return res.status(404).json({ error: 'not_found' });
    if (job.status !== 'awaiting_review') return res.status(409).json({ error: 'job_not_awaiting_review' });

    const existing = job.artifacts?.captions?.lines ?? [];
    const incoming = Array.isArray(req.body?.lines) ? req.body.lines : null;
    if (!incoming) return res.status(400).json({ error: 'lines_required' });
    // Timings are the pipeline's, never the client's: they came from the cut
    // plan, and letting a caller set them would desynchronise the captions
    // from the video it is about to render.
    if (incoming.length !== existing.length) return res.status(400).json({ error: 'lines_length_mismatch' });

    const lines = existing.map((line, i) => ({
      start: line.start,
      end: line.end,
      text: typeof incoming[i]?.text === 'string' ? incoming[i].text.trim().slice(0, 300) : line.text,
    }));

    // Writing the approval and releasing the job in one statement: a crash
    // between them would leave a job that looks reviewed but never resumes.
    await exec(
      db,
      `UPDATE video_edit_jobs
       SET artifacts = jsonb_set(artifacts, '{captions}', ?::jsonb, true),
           status = 'processing',
           claimed_at = NULL,
           -- Waiting for a person is not a failed attempt. Without this reset
           -- the pause would spend one of the job's three retries, and a
           -- reviewed job would have fewer left for real failures.
           attempt_count = 0
       WHERE id = ? AND tenant_id = ? AND status = 'awaiting_review'`,
      JSON.stringify({ approved: true, lines }),
      req.params.id,
      tenantId
    );

    res.json({ job: await getVideoJobForTenant(db, req.params.id, tenantId) });
  }));

  app.post('/api/video-edit-jobs/process-tick', asyncHandler(async (_req, res) => {
    res.json(await advanceRenderJobs(db, new Date(), res.locals.tenantId as string));
  }));

  // ---- Push notifications (shared by Modules 5 and 8) ---------------------

  // The value itself isn't tenant-specific (one VAPID keypair for the
  // whole server), but the route still sits behind requireApiKey like
  // every other /api/* route — fine, since by the time a browser needs
  // this it already has an API key from "Быстрый старт" anyway.
  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({ publicKey: getOrCreateVapidKeys().publicKey });
  });

  app.post('/api/push/subscribe', asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body ?? {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'endpoint and keys.{p256dh,auth} are required' });

    // Re-subscribing with the same endpoint (e.g. browser reloaded the
    // page) updates the existing row instead of erroring or duplicating.
    // A separate DELETE-then-INSERT isn't atomic under a connection pool —
    // two concurrent subscribe calls for the same endpoint could otherwise
    // both pass the DELETE and collide on the endpoint UNIQUE constraint —
    // so this upserts in a single statement instead.
    await exec(
      db,
      `INSERT INTO push_subscriptions (id, tenant_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      randomUUID(),
      res.locals.tenantId,
      endpoint,
      keys.p256dh,
      keys.auth
    );

    res.status(201).json({ status: 'subscribed' });
  }));

  app.post('/api/push/unsubscribe', asyncHandler(async (req, res) => {
    const { endpoint } = req.body ?? {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

    await exec(db, `DELETE FROM push_subscriptions WHERE endpoint = ? AND tenant_id = ?`, endpoint, res.locals.tenantId);
    res.json({ status: 'unsubscribed' });
  }));

  // The in-app fallback the ТЗ requires when push isn't permitted in the
  // browser — polled by the frontend regardless of push permission state.
  app.get('/api/notifications', asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === 'true';
    res.json({ notifications: await listNotifications(db, res.locals.tenantId as string, unreadOnly) });
  }));

  app.post('/api/notifications/:id/read', asyncHandler(async (req, res) => {
    await exec(db, `UPDATE notifications SET is_read = true WHERE id = ? AND tenant_id = ?`, req.params.id, res.locals.tenantId);
    res.json({ status: 'ok' });
  }));

  app.post('/api/notifications/read-all', asyncHandler(async (_req, res) => {
    await exec(db, `UPDATE notifications SET is_read = true WHERE tenant_id = ? AND is_read = false`, res.locals.tenantId);
    res.json({ status: 'ok' });
  }));

  // ---- Incoming message handling -----------------------------------------
  // Shared by the two entry points below: the public mock webhook (Meta's
  // stand-in) and the authenticated in-product simulator. Both must apply
  // the same event_id dedup contract that the real POST /webhooks/instagram
  // will, so the logic lives in one place rather than being duplicated.
  async function handleIncomingMessage(
    bot: Bot,
    eventId: string,
    externalUserId: string,
    messageText: string,
    rawPayload: unknown
  ): Promise<{ status: 'already_processed' } | { outcome: Awaited<ReturnType<typeof runFlow>> }> {
    const claimed = await tryClaimWebhookEvent(db, eventId, bot.id, rawPayload);
    if (!claimed) return { status: 'already_processed' };

    const outcome = await runFlow(db, {
      tenantId: bot.tenant_id,
      botId: bot.id,
      externalUserId,
      messageText,
      isTest: false,
    });

    await exec(db, `UPDATE webhook_events SET processed_at = ? WHERE event_id = ?`, new Date().toISOString(), eventId);
    return { outcome };
  }

  // The in-product "simulate an incoming DM" panel (FlowEditor's test box)
  // calls this instead of the public webhook below. It authenticates with
  // the credential the browser already holds and resolves the bot within
  // the caller's own tenant, so the frontend needs no webhook secret — a
  // secret shipped in a browser bundle would not be a secret at all.
  // eventId is generated here rather than accepted from the client: this
  // route is an explicit user action, not a redelivered platform event, so
  // there is nothing for the caller to deduplicate against.
  app.post('/api/bots/:botId/simulate-incoming', asyncHandler(async (req, res) => {
    const bot = await getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const externalUserId = typeof req.body?.externalUserId === 'string' ? req.body.externalUserId.trim() : '';
    const messageText = typeof req.body?.messageText === 'string' ? req.body.messageText.trim() : '';
    if (!externalUserId) return res.status(400).json({ error: 'externalUserId is required' });
    if (!messageText) return res.status(400).json({ error: 'messageText is required' });

    const eventId = randomUUID();
    const result = await handleIncomingMessage(bot, eventId, externalUserId, messageText, {
      source: 'in_product_simulator',
      eventId,
      externalUserId,
      messageText,
    });
    res.json(result);
  }));

  // ---- Mock Instagram webhook --------------------------------------------
  // Simulates Meta calling us, so it cannot carry a tenant credential —
  // which is exactly why it is gated twice (see webhookAuth.ts): the route
  // only exists when MOCK_WEBHOOK_ENABLED is set, and then only answers
  // callers presenting MOCK_WEBHOOK_SECRET. Left open, it was a remote
  // trigger for sending DMs from any client's account (a bot's
  // external_account_id is a public Instagram handle) and for injecting
  // contacts into their CRM.
  //
  // The real POST /webhooks/instagram will keep this same event_id-dedup
  // contract and swap the shared secret for X-Hub-Signature-256, verified
  // with webhookAuth.ts's timing-safe comparison.
  app.post('/webhooks/mock/instagram', webhookRateLimit, asyncHandler(async (req, res) => {
    // 404, not 403: a disabled simulator should be indistinguishable from
    // one that was never built, so probing cannot confirm it exists.
    if (!isMockWebhookEnabled()) return res.status(404).json({ error: 'not_found' });
    if (!verifyMockWebhookSecret(req.header(MOCK_WEBHOOK_SECRET_HEADER))) {
      return res.status(401).json({ error: 'invalid_webhook_secret' });
    }

    const { eventId, externalAccountId, externalUserId, messageText } = req.body ?? {};
    if (!eventId || !externalAccountId || !externalUserId || !messageText) {
      return res.status(400).json({ error: 'eventId, externalAccountId, externalUserId and messageText are required' });
    }

    const bot = await queryOne<Bot>(db, `SELECT * FROM bots WHERE external_account_id = ?`, externalAccountId);
    if (!bot) return res.status(404).json({ error: 'unknown externalAccountId' });

    res.json(await handleIncomingMessage(bot, eventId, externalUserId, messageText, req.body));
  }));

  // Not every error reaching here is the server's fault. express.json()
  // rejects an oversized body with a 413 and malformed JSON with a 400,
  // attaching the status to the error — blanket-500ing those told the
  // client its own bad request was a server fault, and, worse, buried each
  // one in console.error: a caller could flood the logs (and a hosted
  // platform's log bill) with requests that are merely invalid, while
  // genuine 5xx incidents became impossible to spot among them.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = clientErrorStatus(err);
    if (status) return res.status(status).json({ error: clientErrorCode(status) });

    // Everything else really is unexpected — keep the full log and the
    // opaque body (no stack or message is ever returned to the caller).
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

// Express doesn't await async route handlers on its own — an error thrown
// inside one would become an unhandled rejection instead of reaching the
// error middleware above. Wrapping every async handler through this keeps
// that error path working without adding try/catch to every route.
// body-parser marks its own failures with a 4xx status; anything without
// one is an unexpected server-side error. Narrowed to 4xx deliberately: a
// library that attaches a 5xx status is still reporting a server fault and
// must keep the full logging path below.
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = (err as { status?: unknown; statusCode?: unknown });
  const raw = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof raw !== 'number' || raw < 400 || raw >= 500) return undefined;
  return raw;
}

function clientErrorCode(status: number): string {
  if (status === 413) return 'payload_too_large';
  if (status === 400) return 'malformed_request';
  return 'bad_request';
}

// Route params and body fields that end up in an integer SQL comparison.
// Number() alone was not enough: 'NaN', 'Infinity', '1e400' and '1.5' all
// survive it and then reach Postgres, which rejects them as invalid integer
// syntax — surfacing a plain client typo as a 500. Returns undefined for
// anything that is not a positive, safe, whole number so callers can answer
// 404/400 themselves.
function parsePositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  return n;
}

// Postgres TEXT cannot hold a NUL byte — it rejects the whole statement, so
// any user-supplied string containing one turned into a 500. It is never
// meaningful content here, so it is refused at the edge, once, instead of
// being stripped (silently altering what the user submitted) or repeated as
// a check in every route.
function containsNullByte(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some((item) => containsNullByte(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((item) => containsNullByte(item, depth + 1));
  }
  return false;
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

// Product routes accept either credential issued by this service:
// - tenant API keys remain supported for integrations and existing clients;
// - session JWTs let the first-party browser product use the same routes
//   immediately after signup/login.
//
// Missing/invalid credentials deliberately keep the historical API-key
// error codes because existing API clients may branch on those values.
function requireProductCredential(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const credential = sessionTokenFromRequest(req);
    if (!credential) return res.status(401).json({ error: 'missing_api_key' });

    try {

      // API key first preserves the exact old path (including support for a
      // token whose textual shape happens to resemble a JWT).
      const apiKeyTenantId = await resolveTenantIdFromApiKey(db, credential);
      if (apiKeyTenantId) {
        res.locals.tenantId = apiKeyTenantId;
        return next();
      }

      const session = verifySession(credential);
      if (session.ok) {
        // A correctly signed token for a user/tenant pair that no longer
        // exists is not a valid current product session.
        const user = await queryOne<{ id: string }>(
          db,
          `SELECT id FROM users WHERE id = ? AND tenant_id = ?`,
          session.payload.userId,
          session.payload.tenantId
        );
        if (user) {
          res.locals.tenantId = session.payload.tenantId;
          res.locals.session = session.payload;
          return next();
        }
      }

      return res.status(401).json({ error: 'invalid_api_key' });
    } catch (err) {
      next(err);
    }
  };
}

// Auth-profile routes specifically require a human session and keep their
// more descriptive missing/expired/invalid session errors. Product routes
// above intentionally preserve the older API-key errors for compatibility.
function requireSession(_db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = sessionTokenFromRequest(req);
    if (!token) return res.status(401).json({ error: 'missing_session' });

    const result = verifySession(token);
    if (!result.ok) return res.status(401).json({ error: result.reason === 'expired' ? 'session_expired' : 'invalid_session' });

    res.locals.session = result.payload;
    next();
  };
}

// Scoping every lookup to (id, tenant_id) together — rather than fetching
// by id and checking tenant_id after — means "belongs to another tenant"
// and "doesn't exist" are indistinguishable from the response (both 404).
function getBotForTenant(db: Db, botId: string, tenantId: string): Promise<Bot | undefined> {
  return queryOne<Bot>(db, `SELECT * FROM bots WHERE id = ? AND tenant_id = ?`, botId, tenantId);
}

function getSubscriberForTenant(db: Db, subscriberId: string, tenantId: string): Promise<Subscriber | undefined> {
  return queryOne<Subscriber>(db, `SELECT * FROM subscribers WHERE id = ? AND tenant_id = ?`, subscriberId, tenantId);
}

interface SubscriberTagRef {
  id: string;
  name: string;
}

// Returns {id, name} pairs, not just names — the UI needs the id to call
// DELETE /api/subscribers/:id/tags/:tagId; a bare name isn't enough to
// remove a tag.
// tenantId is required rather than inferred: every caller has already
// restricted its subscriber ids to one tenant, so this was not leaking
// anything, but a tenant filter that exists only in the callers is one
// refactor away from being dropped. Defence in depth on the one helper that
// takes raw ids.
async function tagsForSubscribers(db: Db, subscriberIds: string[], tenantId: string): Promise<Record<string, SubscriberTagRef[]>> {
  if (subscriberIds.length === 0) return {};
  const placeholders = subscriberIds.map(() => '?').join(',');
  const rows = await queryAll<{ subscriberId: string; id: string; name: string }>(
    db,
    `SELECT subscriber_tags.subscriber_id as "subscriberId", tags.id as id, tags.name as name
     FROM subscriber_tags JOIN tags ON subscriber_tags.tag_id = tags.id
     WHERE subscriber_tags.subscriber_id IN (${placeholders}) AND tags.tenant_id = ?`,
    ...subscriberIds,
    tenantId
  );

  const result: Record<string, SubscriberTagRef[]> = {};
  for (const row of rows) {
    (result[row.subscriberId] ??= []).push({ id: row.id, name: row.name });
  }
  return result;
}

function getAnalysisForTenant(db: Db, id: string, tenantId: string): Promise<ReelAnalysis | undefined> {
  return queryOne<ReelAnalysis>(db, `SELECT * FROM reel_analyses WHERE id = ? AND tenant_id = ?`, id, tenantId);
}

function getCarouselForTenant(db: Db, id: string, tenantId: string): Promise<Carousel | undefined> {
  return queryOne<Carousel>(db, `SELECT * FROM carousels WHERE id = ? AND tenant_id = ?`, id, tenantId);
}

function getSlidesForCarousel(db: Db, carouselId: string): Promise<CarouselSlide[]> {
  return queryAll<CarouselSlide>(db, `SELECT * FROM carousel_slides WHERE carousel_id = ? ORDER BY position ASC`, carouselId);
}

function getScheduledPostForTenant(db: Db, id: string, tenantId: string): Promise<ScheduledPost | undefined> {
  return queryOne<ScheduledPost>(db, `SELECT * FROM scheduled_posts WHERE id = ? AND tenant_id = ?`, id, tenantId);
}

// 'publishing' is an internal claim state a row can be observed in between
// the poller's claim UPDATE and its follow-up UPDATE (an await gap that
// didn't exist under the old synchronous SQLite version) — API consumers
// were never designed to handle it, so it's presented as 'scheduled' (what
// it effectively still is, from the outside) rather than leaking the
// implementation detail.
function toPublicScheduledPost(post: ScheduledPost): ScheduledPost {
  return post.status === 'publishing' ? { ...post, status: 'scheduled' } : post;
}

function getVideoJobForTenant(db: Db, id: string, tenantId: string): Promise<VideoEditJob | undefined> {
  return queryOne<VideoEditJob>(db, `SELECT * FROM video_edit_jobs WHERE id = ? AND tenant_id = ?`, id, tenantId);
}

// Returns false if this event_id was already claimed by a prior (or
// concurrent) delivery — the INSERT's PRIMARY KEY(event_id) is the actual
// guarantee, not a prior SELECT, so a race between two deliveries of the
// same webhook can't double-process it.
async function tryClaimWebhookEvent(db: Db, eventId: string, botId: string, payload: unknown): Promise<boolean> {
  try {
    await exec(db, `INSERT INTO webhook_events (event_id, bot_id, payload) VALUES (?, ?, ?)`, eventId, botId, JSON.stringify(payload));
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

function validateFlowDefinition(definition: FlowDefinition): string[] {
  const errors: string[] = [];
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const triggerNodes = definition.nodes.filter((node) => node.type === 'trigger');

  if (triggerNodes.length !== 1) {
    errors.push(`flow must have exactly one trigger node, found ${triggerNodes.length}`);
  }

  for (const edge of definition.edges) {
    if (!nodeIds.has(edge.source)) errors.push(`edge ${edge.id} references unknown source node ${edge.source}`);
    if (!nodeIds.has(edge.target)) errors.push(`edge ${edge.id} references unknown target node ${edge.target}`);
  }

  for (const node of definition.nodes) {
    if (node.type === 'send_message' && !node.data.text.trim()) {
      errors.push(`send_message node ${node.id} has empty text`);
    }
  }

  if (triggerNodes.length === 1 && collectMessageNodes(definition).length === 0) {
    errors.push('no send_message node is reachable from the trigger node');
  }

  return errors;
}
