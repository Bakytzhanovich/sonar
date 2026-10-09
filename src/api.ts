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
import {
  DEFAULT_SUBTITLE_COLOUR,
  DEFAULT_SUBTITLE_FONT,
  DEFAULT_SUBTITLE_SIZE,
  isSubtitleColourId,
  isSubtitleFontId,
  isSubtitleSizeId,
  SUBTITLE_COLOURS,
  SUBTITLE_FONTS,
  SUBTITLE_SIZES,
} from './subtitleAxes';
import { ASPECT_RATIOS, DEFAULT_ASPECT_RATIO, isAspectRatioId } from './aspect';
import { HEADLINE_MAX_CHARS, sanitizeHeadline } from './headline';
import {
  DEFAULT_HEADLINE_COLOUR, DEFAULT_HEADLINE_FONT, DEFAULT_HEADLINE_SIZE,
  HEADLINE_COLOURS, HEADLINE_FONTS, HEADLINE_SIZES,
  isHeadlineColourId, isHeadlineFontId, isHeadlineSizeId,
} from './headlineStyles';
import { isAwaitingWorker } from './jobLease';
import { asRole, canPerform, requiredRole, ROLE_LABELS } from './roles';
import { SMART_CUT_WORKER, isWorkerOnline } from './workerHealth';
import { runFlow, collectMessageNodes } from './flowEngine';
import { getActiveTriggersForBot, normalizeKeyword } from './triggerMatcher';
import { generateCarouselSlides } from './carouselGeneration';
import { PLATFORM_NAME, publishDuePosts } from './publisher';
import { authorizeUrl, connectWithCode, instagramConfigFromEnv, signState, verifyState, type InstagramAppConfig } from './instagramAuth';
import { listAccounts, saveConnectedAccount } from './platformAccounts';
import { keyringFromEnv, type TokenKeyring } from './tokenVault';
import { eraseAccount } from './accountDeletion';
import { PRIVACY_POLICY_VERSION } from './privacyPolicy';
import { eraseContactFromPlan, generateContentPlan, getContentPlan, NotEnoughDataError, planReadiness, scriptFor, writeTopicScript } from './contentTopics';
import { addDays, autoFillWeek, isDay, listEntries } from './contentCalendar';
import { computeContentRecommendations } from './contentRecommendations';
import { advanceRenderJobs } from './videoRender';
import { assToRgb } from './assColour';
import { fontFileFor, loadFontMetrics } from './fontMetrics';
import { DEFAULT_POSTER_OPTIONS } from './subtitles';
import { REFERENCE_FRAME } from './aspect';
import { pickPreviewWindow } from './previewWindow';
import { adaptReelScript, openAiChatFromEnv, ReelAnalysisError, type ChatModel } from './reelLlm';
import { normalizeManualSegments } from './smartCut';
import { deleteObject, downloadUrlFor, MAX_SOURCE_BYTES, presign, storageConfigFromEnv } from './storage';
import { localMediaConfigFromEnv, resolveKeyPath, signLocalUrl, verifyLocalUrl } from './localMedia';
import { notify, listNotifications } from './notifications';
import { getOrCreateVapidKeys } from './vapidKeys';
import type {
  Bot,
  Carousel,
  ContactProfile,
  CarouselSlide,
  FlowDefinition,
  GeneratedScript,
  ReelAnalysis,
  PostingPlatform,
  ScheduledPost,
  Subscriber,
  Trigger,
  TriggerNode,
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
// Long enough to watch a clip through and redraw its cuts without the video
// element dying mid-scrub, which is how an expired source URL shows up: the
// player simply stops seeking and nothing says why.
const EDITOR_SOURCE_TTL_SEC = 2 * 60 * 60;
// Reel analysis failures another attempt can actually change: a model that
// answered badly, a transcription service that hiccupped, a quota that has
// since refilled. Everything else is a fact about the file.
const REEL_RETRYABLE = new Set([
  'llm_failed',
  'llm_invalid_answer',
  'transcription_failed',
  'transcription_quota_exhausted',
]);
// Long enough to read two or three captions, short enough that the render is
// over before anyone gives up waiting for it.
const PREVIEW_SECONDS = 4;
// Ceiling for a single upload through the local dev store. A reel is a few
// hundred megabytes at most; without a cap one request can exhaust the
// process's memory, since express.raw buffers the whole body.
// The local store's own ceiling — the same one the worker holds R2 sources to.
const MAX_UPLOAD_BYTES = MAX_SOURCE_BYTES;

const DEMO_BOT_NAME = 'Sonar Demo';
const DEMO_EXTERNAL_USER_ID = 'sonar-demo-contact';

function demoExternalAccountId(tenantId: string): string {
  return `demo:${tenantId}`;
}

export interface AppOptions {
  /** The model that adapts reel scripts. Injected by tests so they never
   *  reach the network; defaults to OpenAI with the key from the environment. */
  reelChat?: ChatModel;
  /** Encryption keys for platform tokens. Absent means "from the
   *  environment"; null means "not configured", which tests use to check the
   *  refusal. */
  tokenKeyring?: TokenKeyring | null;
  /** The Meta app. Same absent/null convention as tokenKeyring. */
  instagram?: InstagramAppConfig | null;
  /** Every request to Instagram goes through this. Tests pass a fake. */
  instagramFetch?: typeof fetch;
}

// The test connection is development tooling, like the mock pipelines: never
// on the site customers use.
const MOCK_CONNECT_AVAILABLE = process.env.NODE_ENV !== 'production';

export function createApp(db: Db, options: AppOptions = {}): Express {
  const reelChat = options.reelChat ?? openAiChatFromEnv();
  const tokenKeyring = 'tokenKeyring' in options ? options.tokenKeyring ?? null : keyringFromEnv();
  const instagram = 'instagram' in options ? options.instagram ?? null : instagramConfigFromEnv();
  const instagramFetch = options.instagramFetch ?? fetch;
  // Tied to the session secret like every other derived key, but its own:
  // a state can never be mistaken for any other signed thing.
  const oauthStateKey = deriveKey('instagram-oauth-state');
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

  // Per workspace, not per address, and only on what costs money: every one
  // of these calls a paid model or transcription. Sign-up is open, so without
  // a ceiling anyone could register and loop a generate button into the
  // model bill. The ceilings are far above what a person does in an hour and
  // far below what a script does in a minute. Keyed on the tenant — these
  // routes sit behind requireProductCredential, which sets it.
  const perTenant = (limit: number, windowMs: number, message: string) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (_req, res) => `tenant:${String(res.locals.tenantId)}`,
      message: { error: message },
    });
  const HOUR = 60 * 60 * 1000;
  // Text from the model: carousels, plans, scripts.
  const aiRateLimit = perTenant(30, HOUR, 'Слишком много запросов к ИИ за час — подождите немного и попробуйте снова');
  // Work that transcribes a recording: a reel analysis, a new edit, a re-edit.
  const mediaRateLimit = perTenant(20, HOUR, 'Слишком много роликов за час — подождите немного и попробуйте снова');
  // A few seconds of ffmpeg each, but each is a worker job.
  const previewRateLimit = perTenant(60, HOUR, 'Слишком много предпросмотров за час — подождите немного');
  // Upload tickets: each one is room in the bucket.
  const uploadRateLimit = perTenant(40, HOUR, 'Слишком много загрузок за час — подождите немного');

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

  // The caller's own address, as this server sees it — nothing a caller does
  // not already know. It exists to check one deployment fact: the per-address
  // limits on sign-in and sign-up only work if req.ip is the visitor, not the
  // frontend proxy in front of this API. If two different networks see the
  // same address here, every visitor shares one limit, and TRUST_PROXY needs
  // to count one more hop (the frontend's own load balancer).
  app.get('/api/auth/client-ip', (req, res) => res.json({ ip: req.ip }));

  // ---- Instagram connection: the way back from instagram.com ---------------
  // Before requireProductCredential, like the media routes below: this is a
  // browser arriving from Instagram, and the signed `state` — minted by the
  // owner's own session a few minutes earlier — is what says which workspace
  // it belongs to. Every outcome ends on the scheduler, which reads the
  // result from the address and says it in words.
  app.get('/api/oauth/instagram/callback', asyncHandler(async (req, res) => {
    const back = (outcome: string) => res.redirect(302, `/scheduler?instagram=${outcome}`);
    // The person pressed "Cancel" on Instagram's own screen.
    if (req.query.error) return back('denied');
    const tenantId = verifyState(oauthStateKey, req.query.state);
    if (!tenantId) return back('expired');
    if (!instagram || !tokenKeyring) return back('unavailable');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return back('failed');
    try {
      const profile = await connectWithCode(instagram, code, instagramFetch);
      await saveConnectedAccount(db, tokenKeyring, tenantId, 'instagram', profile);
      return back('connected');
    } catch (err) {
      // The reason, which instagramAuth keeps free of tokens and URLs.
      console.warn(`[instagram] connect failed for ${tenantId}: ${err instanceof Error ? err.message.slice(0, 300) : 'unknown'}`);
      return back('failed');
    }
  }));

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
    // Consent to processing personal data, given explicitly (Kazakhstan's
    // personal data law). After the invite gate, so a caller without an
    // invite learns nothing new from leaving it out.
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: 'consent_required' });
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
      await exec(
        db,
        `INSERT INTO users (id, tenant_id, email, password_hash, privacy_consent_at, privacy_policy_version) VALUES (?, ?, ?, ?, now(), ?)`,
        userId,
        tenantId,
        email,
        passwordHash,
        PRIVACY_POLICY_VERSION
      );
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
    // The token travels only in the httpOnly cookie. Echoing it in the body
    // put it within reach of any script on the page — the one thing the
    // cookie exists to prevent — and the frontend never read it from there.
    res.status(201).json({ user: { id: userId, email }, tenant: { id: tenantId, name: email } });
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
    res.json({ user: { id: user.id, email: user.email }, tenant });
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
    // The role travels with the profile so the interface can stop offering
    // what the API will refuse. It is not the enforcement — that is
    // requireRoleForRequest, server-side — only what lets a viewer see a
    // read-only screen instead of buttons that answer 403.
    res.json({ user: { id: user.id, email: user.email, role: asRole(user.role) }, tenant });
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
      // The look, plus the numbers behind it. The browser draws a live
      // preview of these captions, and it has to draw them from the same
      // figures the renderer uses — a second copy in CSS would let the
      // preview and the render disagree about what "Классика" is.
      //
      // Sizes travel as a share of the frame WIDTH, because that is the
      // dimension caption sizes are scaled by (see scaleStyleToFrame). In CSS
      // that is a container-query width unit, so the two agree by
      // construction rather than by coincidence.
      presets: SUBTITLE_PRESETS.map(({ id, label, description, badge, style }) => ({
        id,
        label,
        description,
        badge,
        layout: {
          fontFamily: style.fontName,
          fontSizeRatio: style.fontSize / REFERENCE_FRAME.width,
          outlineRatio: style.outline / REFERENCE_FRAME.width,
          shadowRatio: style.shadow / REFERENCE_FRAME.width,
          marginRatio: style.marginV / REFERENCE_FRAME.height,
          // 1 bottom row, 2 middle, 3 top — libass's numpad, resolved here so
          // the browser does not have to know that alphabet.
          row: Math.ceil(style.alignment / 3) === 3 ? 'top' : Math.ceil(style.alignment / 3) === 1 ? 'bottom' : 'middle',
          primary: assToRgb(style.primaryColour),
          highlight: assToRgb(style.highlightColour),
          // Only the poster style stacks and emphasises; the rest are one
          // line, and the browser needs to know which is which.
          poster: id === 'poster',
        },
      })),
      // What the poster layout does, for the preview to mirror.
      posterLayout: {
        emphasisScale: DEFAULT_POSTER_OPTIONS.emphasisScale,
        overlap: DEFAULT_POSTER_OPTIONS.overlap,
        uppercase: DEFAULT_POSTER_OPTIONS.uppercaseEmphasis,
      },
      sizeScales: Object.fromEntries(SUBTITLE_SIZES.map((s) => [s.id, s.scale])),
      // How big libass draws the em for each family, relative to the size it
      // is asked for (see assEmRatio). The browser treats a font size as the
      // em and libass does not, so without this every preview size is 40-70%
      // too large. Read from the same .ttf files the renderer uses; a family
      // with no file here is left out, and the preview draws it unscaled —
      // libass would be substituting some other face for it anyway.
      fontEmRatios: Object.fromEntries(
        [...new Set([
          ...SUBTITLE_PRESETS.map((p) => p.style.fontName),
          ...SUBTITLE_FONTS.map((f) => f.family).filter(Boolean),
          ...HEADLINE_FONTS.map((f) => f.family),
        ])].flatMap((family) => {
          try {
            return [[family, loadFontMetrics(fontFileFor(family)).assEmRatio]];
          } catch {
            return [];
          }
        })
      ),
      // Shipped alongside the looks rather than from a second endpoint: the
      // picker shows both, and one request means the two can never arrive out
      // of step with each other.
      // Each position carries its own margin, not just an alignment: the top
      // one clears the platform's header, the bottom one clears the Reels
      // controls. The preview has to use those, not the preset's — otherwise
      // "Сверху" sits under someone else's interface in the preview and
      // clears it in the render.
      positions: SUBTITLE_POSITIONS.map(({ id, label, description, alignment, marginV }) => ({
        id,
        label,
        description,
        // Resolved out of libass's numpad here so the browser does not have
        // to know that alphabet, and named the way the CSS does.
        row: alignment === null ? null : alignment >= 7 ? 'top' : alignment <= 3 ? 'bottom' : 'middle',
        marginRatio: marginV === null ? null : marginV / REFERENCE_FRAME.height,
      })),
      // The three axes a preset used to bundle. Sent from here rather than
      // kept in the browser for the same reason as everything else in this
      // response: the renderer owns what it can actually draw.
      // The family travels beside the label because the preview has to draw
      // in it, and the two are not the same string: 'auto' is labelled
      // "Как в стиле" and has no family of its own. Using the label as a
      // font name is how the live preview ended up asking the browser for a
      // typeface called "Как в стиле" and getting a serif fallback.
      subtitleFonts: SUBTITLE_FONTS.map(({ id, label, description, family }) => ({ id, label, description, family })),
      // The hex travels too — the picker paints a dot in each colour, and
      // deriving it in the browser would be a second place the palette lives.
      subtitleColors: SUBTITLE_COLOURS.map(({ id, label, description, hex }) => ({ id, label, description, hex })),
      subtitleSizes: SUBTITLE_SIZES.map(({ id, label, description }) => ({ id, label, description })),
      // The renderer's limit, not a second copy of it in the browser.
      headlineMaxChars: HEADLINE_MAX_CHARS,
      // The headline catalogues travel with the caption ones for the same
      // reason: the picker renders what the renderer actually has.
      headlineFonts: HEADLINE_FONTS.map(({ id, label, description, family }) => ({ id, label, description, family })),
      headlineSizes: HEADLINE_SIZES.map(({ id, label, description }) => ({ id, label, description })),
      // The hex travels so the picker can paint a dot; the ASS form stays
      // server-side, where the renderer is.
      headlineColors: HEADLINE_COLOURS.map(({ id, label, description, hex }) => ({ id, label, description, hex })),
      // Same journey as the rest: the frame shapes the renderer can actually
      // produce, rather than a list the browser keeps its own copy of.
      aspectRatios: ASPECT_RATIOS.map(({ id, label, description }) => ({ id, label, description })),
    });
  });

  app.use('/api', requireProductCredential(db));
  app.use('/api', requireRoleForRequest);

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
      // Named, so the first contact a new customer meets in their CRM reads
      // as a person and says plainly it is not a real one.
      profile: { displayName: 'Демо-контакт' },
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

    const { keyword, matchType, flowId } = req.body ?? {};
    // Types checked, not only presence: an object for the keyword crashed
    // its normalisation, and a non-numeric version reached Postgres as an
    // integer comparison — both answered 500 for what is a bad request.
    const flowVersion = parsePositiveInt(req.body?.flowVersion);
    if (typeof keyword !== 'string' || !keyword.trim() || typeof flowId !== 'string' || !flowId || flowVersion === undefined) {
      return res.status(400).json({ error: 'keyword, flowId and flowVersion are required' });
    }
    if (matchType !== undefined && matchType !== 'contains' && matchType !== 'exact') {
      return res.status(400).json({ error: 'matchType must be contains or exact' });
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

  // Makes a published version the one the bot answers with. Publishing alone
  // never did: a trigger is pinned to a version, and binding a second time
  // with the same keyword was a 409 — so an edited scenario was published and
  // then never reached a single subscriber. The keyword comes from the
  // version's own trigger node rather than the request, so what the bot
  // listens for and what the scenario says cannot drift apart. A flow has
  // exactly one trigger node, so any other live trigger on this flow is a
  // leftover from an earlier keyword and is switched off.
  app.post('/api/flows/:flowId/versions/:version/go-live', asyncHandler(async (req, res) => {
    const version = parsePositiveInt(req.params.version);
    if (version === undefined) return res.status(404).json({ error: 'flow not found' });
    const flow = await queryOne<{ definition: FlowDefinition; status: string; bot_id: string; tenant_id: string }>(
      db,
      `SELECT flows.definition, flows.status, flows.bot_id, bots.tenant_id
       FROM flows JOIN bots ON flows.bot_id = bots.id
       WHERE flows.id = ? AND flows.version = ?`,
      req.params.flowId,
      version
    );
    if (!flow || flow.tenant_id !== res.locals.tenantId) return res.status(404).json({ error: 'flow not found' });
    if (flow.status !== 'published') {
      return res.status(422).json({ error: 'cannot go live with a version that is not published' });
    }
    const triggerNode = flow.definition.nodes.find((n): n is TriggerNode => n.type === 'trigger');
    if (!triggerNode) return res.status(422).json({ error: 'flow has no trigger' });
    const { keyword, matchType } = triggerNode.data;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await queryAll<{ id: string }>(
        client,
        `SELECT id FROM triggers WHERE bot_id = ? AND flow_id = ? AND is_active = true ORDER BY created_at DESC FOR UPDATE`,
        flow.bot_id,
        req.params.flowId
      );
      const [keep, ...stale] = current;
      for (const t of stale) await exec(client, `UPDATE triggers SET is_active = false WHERE id = ?`, t.id);
      const triggerId = keep?.id ?? randomUUID();
      if (keep) {
        await exec(
          client,
          `UPDATE triggers SET flow_version = ?, keyword = ?, match_type = ? WHERE id = ?`,
          version,
          keyword,
          matchType,
          keep.id
        );
      } else {
        await exec(
          client,
          `INSERT INTO triggers (id, bot_id, flow_id, flow_version, keyword, match_type) VALUES (?, ?, ?, ?, ?, ?)`,
          triggerId,
          flow.bot_id,
          req.params.flowId,
          version,
          keyword,
          matchType
        );
      }
      await client.query('COMMIT');
      res.json({ trigger: { id: triggerId, flow_id: req.params.flowId, flow_version: version, keyword, match_type: matchType, is_active: true } });
    } catch (err) {
      await client.query('ROLLBACK');
      // Another flow on this bot already answers this keyword — the same
      // unique index that guards POST /triggers, and the same answer.
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'a trigger with this keyword already exists for this bot' });
      }
      throw err;
    } finally {
      client.release();
    }
  }));

  // ---- Test mode ---------------------------------------------------------
  app.post('/api/bots/:botId/test', asyncHandler(async (req, res) => {
    const bot = await getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const { externalUserId, messageText } = req.body ?? {};
    // Strings, not merely present: a number for the message crashed keyword
    // matching (text.trim) and answered 500.
    if (typeof externalUserId !== 'string' || !externalUserId || typeof messageText !== 'string' || !messageText) {
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
      // Before the messages go: they are what identifies this person's quotes.
      await eraseContactFromPlan(client, res.locals.tenantId as string, subscriber.id);
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

  // ---- Module 3: Reel analysis and script adaptation -------------------
  // An uploaded reel, not a link: downloading other people's reels is the
  // same legal question that keeps Module 7 unstarted, and the person usually
  // has the file anyway. The row is created here and filled in by the worker
  // (reelPipeline.ts) — transcription and a model call are not something to
  // hold a request open for.
  app.post('/api/reel-analyses', mediaRateLimit, asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const sourceObjectKey = typeof req.body?.sourceObjectKey === 'string' ? req.body.sourceObjectKey.trim() : '';
    if (!sourceObjectKey) return res.status(400).json({ error: 'sourceObjectKey is required' });
    // Multi-tenancy isolation (CLAUDE.md), same check as the video jobs: the
    // key must come from this tenant's own upload, or a tenant could have the
    // worker transcribe — and hand back the words of — someone else's file.
    if (!sourceObjectKey.startsWith(`tenants/${tenantId}/sources/`)) {
      return res.status(403).json({ error: 'source_object_key_not_owned' });
    }
    // Optional, for the person's own reference; never fetched.
    const sourceUrl = typeof req.body?.sourceUrl === 'string' ? req.body.sourceUrl.trim().slice(0, 500) || null : null;

    const id = randomUUID();
    await exec(
      db,
      `INSERT INTO reel_analyses (id, tenant_id, source_url, source_object_key, status) VALUES (?, ?, ?, ?, 'processing')`,
      id,
      tenantId,
      sourceUrl,
      sourceObjectKey
    );

    const analysis = (await getAnalysisForTenant(db, id, tenantId))!;
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

    // The reel itself, so the screen can play it beside its analysis and a
    // person can check "the solution starts at 0:09" against the video rather
    // than take it on trust. Signed here and not in the list, which is polled
    // every few seconds while anything is processing.
    const storage = storageConfigFromEnv();
    const key = analysis.source_object_key;
    const videoUrl = key
      ? storage
        ? presign(storage, { method: 'GET', key, expiresInSec: EDITOR_SOURCE_TTL_SEC })
        : localMedia
          ? signLocalUrl(localMedia, 'GET', key, EDITOR_SOURCE_TTL_SEC)
          : null
      : null;

    res.json({ analysis, videoUrl });
  }));

  // Removes an analysis, its scripts and the uploaded reel. The file goes too:
  // it is somebody else's video, kept only so it could be analysed and
  // played back, and there is no reason to hold it after the person is done.
  app.delete('/api/reel-analyses/:id', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const analysis = await getAnalysisForTenant(db, req.params.id, tenantId);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });

    // One transaction with the row locked first, because a script can be
    // generating while the person deletes: the model call takes seconds, and
    // a script saved between the two DELETEs would leave a child pointing at
    // the analysis — the second DELETE fails, the earlier scripts are already
    // gone and the analysis stays. The lock makes the script insert below
    // wait for this to finish, then find nothing to attach to.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await exec(client, `SELECT id FROM reel_analyses WHERE id = ? AND tenant_id = ? FOR UPDATE`, analysis.id, tenantId);
      await exec(client, `DELETE FROM generated_scripts WHERE analysis_id = ? AND tenant_id = ?`, analysis.id, tenantId);
      await exec(client, `DELETE FROM reel_analyses WHERE id = ? AND tenant_id = ?`, analysis.id, tenantId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // After the rows, and never fatal: a file that could not be removed is
    // storage to tidy later, while a row left behind is a reel still showing
    // in the person's library after they deleted it.
    const key = analysis.source_object_key;
    if (key && key.startsWith(`tenants/${tenantId}/`)) {
      const storage = storageConfigFromEnv();
      const removal = storage
        ? deleteObject(storage, key)
        : localMedia
          ? fsp.rm(resolveKeyPath(localMedia, key), { force: true })
          : Promise.resolve();
      await removal.catch((err: unknown) =>
        console.warn(`[api] reel ${analysis.id}: uploaded file not removed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }

    res.status(204).end();
  }));

  // Runs a failed analysis again from the same upload. Only where another
  // attempt can change the answer: a reel with no speech, no sound or three
  // minutes too many will fail the same way, and each retry would be another
  // transcription bill for the same outcome.
  app.post('/api/reel-analyses/:id/retry', mediaRateLimit, asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const analysis = await getAnalysisForTenant(db, req.params.id, tenantId);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });
    if (analysis.status !== 'failed') return res.status(409).json({ error: 'not_failed' });
    if (!analysis.source_object_key || !REEL_RETRYABLE.has(analysis.failure_reason ?? '')) {
      return res.status(409).json({ error: 'not_retryable' });
    }

    await exec(
      db,
      `UPDATE reel_analyses
       SET status = 'processing', stage = NULL, failure_reason = NULL, attempt_count = 0, claimed_at = NULL
       WHERE id = ? AND tenant_id = ? AND status = 'failed'`,
      analysis.id,
      tenantId
    );
    res.json({ analysis: await getAnalysisForTenant(db, analysis.id, tenantId) });
  }));

  app.post('/api/reel-analyses/:id/scripts', aiRateLimit, asyncHandler(async (req, res) => {
    const analysis = await getAnalysisForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });

    const niche = typeof req.body?.niche === 'string' ? req.body.niche.trim().slice(0, 100) : '';
    if (!niche) return res.status(400).json({ error: 'niche is required' });
    // A script needs a finished analysis to adapt; one still being transcribed
    // has nothing to give it yet.
    if (analysis.status !== 'completed' || !analysis.hook || !analysis.structure) {
      return res.status(409).json({ error: 'analysis_not_ready' });
    }

    let scriptText: string;
    try {
      scriptText = await adaptReelScript(
        { hook: analysis.hook, structure: analysis.structure.map((b) => ({ ...b, summary: b.summary ?? '' })), why: analysis.why ?? '' },
        niche,
        reelChat
      );
    } catch (err) {
      // Said plainly rather than replaced with a template: a canned script
      // presented as adapted is exactly what this module stopped doing.
      const reason = err instanceof ReelAnalysisError ? err.reason : 'llm_failed';
      return res.status(reason === 'llm_not_configured' ? 503 : 502).json({ error: reason });
    }
    const id = randomUUID();
    // Attached only if the analysis is still there: it may have been deleted
    // while the model was writing. FOR SHARE waits out a delete in progress
    // (see DELETE above) instead of racing it into a foreign-key error.
    const saved = await queryAll<{ id: string }>(
      db,
      `INSERT INTO generated_scripts (id, tenant_id, analysis_id, niche, script_text)
       SELECT ?, tenant_id, id, ?, ? FROM reel_analyses WHERE id = ? AND tenant_id = ? FOR SHARE
       RETURNING id`,
      id, niche, scriptText, analysis.id, res.locals.tenantId
    );
    if (saved.length === 0) return res.status(404).json({ error: 'analysis not found' });

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

  // "Промпт → готовая карусель". The text comes first, and only then is
  // anything written: a model that fails must not leave an empty carousel in
  // the library. And when it does fail, the person is told — never handed
  // template slides as if they were generated (see carouselGeneration.ts).
  app.post('/api/carousels', aiRateLimit, asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const presetId = req.body?.presetId ?? null;
    if (presetId) {
      const preset = await queryOne(db, `SELECT id FROM brand_presets WHERE id = ? AND tenant_id = ?`, presetId, tenantId);
      if (!preset) return res.status(404).json({ error: 'preset not found' });
    }

    let slides;
    try {
      slides = await generateCarouselSlides(prompt, reelChat);
    } catch (err) {
      const reason = err instanceof ReelAnalysisError ? err.reason : 'llm_failed';
      return res.status(reason === 'llm_not_configured' ? 503 : 502).json({ error: reason });
    }

    // The carousel and its slides in one transaction, so nobody can ever
    // read a carousel with only some of its slides.
    const carouselId = randomUUID();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await exec(client, `INSERT INTO carousels (id, tenant_id, prompt, preset_id) VALUES (?, ?, ?, ?)`, carouselId, tenantId, prompt, presetId);
      const slideParams = slides.flatMap((slide, i) => [randomUUID(), carouselId, tenantId, i, slide.headline, slide.body]);
      const valuesSql = slides.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
      await exec(client, `INSERT INTO carousel_slides (id, carousel_id, tenant_id, position, headline, body) VALUES ${valuesSql}`, ...slideParams);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

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
  // Slides first (they reference the carousel), both in one transaction so a
  // failure halfway cannot leave a carousel with half its slides.
  app.delete('/api/carousels/:id', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const carousel = await getCarouselForTenant(db, req.params.id, tenantId);
    if (!carousel) return res.status(404).json({ error: 'carousel not found' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await exec(client, `DELETE FROM carousel_slides WHERE carousel_id = ? AND tenant_id = ?`, carousel.id, tenantId);
      await exec(client, `DELETE FROM carousels WHERE id = ? AND tenant_id = ?`, carousel.id, tenantId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.status(204).end();
  }));

  // The brand style a carousel is shown and downloaded in. Kept on the
  // carousel, so coming back to it does not quietly fall back to plain.
  app.patch('/api/carousels/:id', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const presetId = req.body?.presetId ?? null;
    if (presetId !== null && typeof presetId !== 'string') return res.status(400).json({ error: 'presetId must be a string or null' });
    if (presetId) {
      const preset = await queryOne(db, `SELECT id FROM brand_presets WHERE id = ? AND tenant_id = ?`, presetId, tenantId);
      if (!preset) return res.status(404).json({ error: 'preset not found' });
    }
    const updated = await queryOne<{ id: string }>(
      db,
      `UPDATE carousels SET preset_id = ? WHERE id = ? AND tenant_id = ? RETURNING id`,
      presetId,
      req.params.id,
      tenantId
    );
    if (!updated) return res.status(404).json({ error: 'carousel not found' });
    res.json({ carousel: await getCarouselForTenant(db, req.params.id, tenantId) });
  }));

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

  // A post is a reel, so it carries a video: either a file uploaded for it
  // (videoObjectKey, from POST /api/video-uploads) or a finished render from
  // the editor (videoJobId) — "edited it, now post it" without downloading
  // and uploading the same file again.
  async function resolvePostVideo(
    tenantId: string,
    body: Record<string, unknown>
  ): Promise<{ key: string; jobId: string | null } | { status: number; error: string }> {
    const jobId = typeof body.videoJobId === 'string' ? body.videoJobId : '';
    const key = typeof body.videoObjectKey === 'string' ? body.videoObjectKey.trim() : '';
    if (jobId) {
      const job = await queryOne<{ status: string; output_object_key: string | null; preview_of: string | null }>(
        db,
        `SELECT status, output_object_key, preview_of FROM video_edit_jobs WHERE id = ? AND tenant_id = ?`,
        jobId,
        tenantId
      );
      if (!job) return { status: 404, error: 'video job not found' };
      // A preview is four seconds of a style being tried, and is swept away
      // within hours — not something to schedule.
      if (job.preview_of || job.status !== 'completed' || !job.output_object_key) return { status: 409, error: 'video_not_ready' };
      return { key: job.output_object_key, jobId };
    }
    if (key) {
      // Same rule as every other upload consumer: only this tenant's own
      // uploads, or a post could publish another client's video.
      if (!key.startsWith(`tenants/${tenantId}/sources/`)) return { status: 403, error: 'video does not belong to this account' };
      return { key, jobId: null };
    }
    return { status: 400, error: 'video is required: videoJobId or videoObjectKey' };
  }

  // The stored key never leaves the server; what does is a link the queue
  // can play, signed for as long as an editor session.
  function postForClient(post: ScheduledPost) {
    // The storage key, and the machinery of Instagram's container flow, stay
    // here. What the screen gets is the state, the reason it is waiting or
    // failed, and a link to play.
    const {
      video_object_key,
      ig_container_id: _container,
      publish_stage: _stage,
      container_created_at: _created,
      next_attempt_at: _next,
      attempts: _attempts,
      ...rest
    } = toPublicScheduledPost(post);
    let videoUrl: string | null = null;
    if (video_object_key) {
      const storage = storageConfigFromEnv();
      videoUrl = storage
        ? presign(storage, { method: 'GET', key: video_object_key, expiresInSec: EDITOR_SOURCE_TTL_SEC })
        : localMedia
          ? signLocalUrl(localMedia, 'GET', video_object_key, EDITOR_SOURCE_TTL_SEC)
          : null;
    }
    return { ...rest, video_url: videoUrl };
  }

  /** Why this account cannot take a post on this platform, or null when it can. */
  async function refusePostAccount(tenantId: string, accountId: string, platform: string): Promise<{ status: number; error: string } | null> {
    const account = await queryOne<{ platform: string; status: string }>(
      db,
      `SELECT platform, status FROM platform_accounts WHERE id = ? AND tenant_id = ?`,
      accountId,
      tenantId
    );
    if (!account) return { status: 404, error: 'account not found' };
    if (account.platform !== platform) return { status: 400, error: 'account is for another platform' };
    if (account.status !== 'active') return { status: 409, error: 'account_needs_reconnect' };
    return null;
  }

  app.post('/api/scheduled-posts', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const { platform, caption, scheduledAt, requiresApproval } = req.body ?? {};
    if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: `platform must be one of: ${PLATFORMS.join(', ')}` });
    if (!caption || typeof caption !== 'string') return res.status(400).json({ error: 'caption is required' });
    if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) return res.status(400).json({ error: 'scheduledAt must be a valid date' });
    const video = await resolvePostVideo(tenantId, req.body ?? {});
    if ('error' in video) return res.status(video.status).json({ error: video.error });

    // Which connected account it goes to. Optional — with none, the post
    // goes through the mock (there is nothing real to post to) — but when
    // given it must be this workspace's, for this platform, and working.
    const accountId = typeof req.body?.platformAccountId === 'string' ? req.body.platformAccountId : null;
    if (accountId) {
      const refused = await refusePostAccount(tenantId, accountId, platform);
      if (refused) return res.status(refused.status).json({ error: refused.error });
    }

    const id = randomUUID();
    const status = requiresApproval ? 'pending_approval' : 'scheduled';
    await exec(
      db,
      `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, requires_approval, status, video_object_key, video_job_id, platform_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      tenantId,
      platform,
      caption,
      new Date(scheduledAt).toISOString(),
      Boolean(requiresApproval),
      status,
      video.key,
      video.jobId,
      accountId
    );

    if (status === 'pending_approval') {
      await notify(db, tenantId, 'post_pending_approval', `Пост в ${PLATFORM_NAME[platform as PostingPlatform]} ждёт согласования`, id);
    }

    // toPublicScheduledPost, not the raw row: the background publisher
    // timer (or a concurrent /process-due call) can claim this row to
    // 'publishing' between the INSERT above and this read-back, and
    // 'publishing' is an internal transient state every other endpoint
    // in this file already hides from API consumers.
    const created = await getScheduledPostForTenant(db, id, res.locals.tenantId as string);
    res.status(201).json({ post: created && postForClient(created) });
  }));

  // The calendar/queue screen from the ТЗ reads from here, filtered by
  // status and/or date range.
  app.get('/api/scheduled-posts', asyncHandler(async (req, res) => {
    const { status, from, to } = req.query as { status?: string; from?: string; to?: string };
    // new Date('nonsense').toISOString() throws, which surfaced a typo in a
    // filter as a 500.
    if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) {
      return res.status(400).json({ error: 'from and to must be dates' });
    }
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

    res.json({ posts: posts.map(postForClient) });
  }));

  app.get('/api/scheduled-posts/:id', asyncHandler(async (req, res) => {
    const post = await getScheduledPostForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!post) return res.status(404).json({ error: 'post not found' });
    res.json({ post: postForClient(post) });
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
    res.json({ post: fresh && postForClient(fresh) });
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
    res.json({ post: fresh && postForClient(fresh) });
  }));

  // ---- Changing your mind -------------------------------------------------
  // One rule for cancel and edit: a post can be changed until it has been
  // handed to Instagram, and not after. Before that it is only a row of ours;
  // after, a container exists on Instagram's side and may already be live.
  // The rule sits in each statement's WHERE, so the publisher claiming the
  // post a moment earlier makes the change match nothing — never a cancel
  // of a reel that is already going out.
  const CHANGEABLE = `(status IN ('pending_approval', 'scheduled')
    OR (status = 'publishing' AND claimed_at IS NULL AND ig_container_id IS NULL))`;

  /** 404 for someone else's or a missing post, 409 with the reason otherwise. */
  async function whyNotChangeable(id: string, tenantId: string): Promise<{ status: number; error: string }> {
    const post = await getScheduledPostForTenant(db, id, tenantId);
    if (!post) return { status: 404, error: 'post not found' };
    if (post.status === 'published') return { status: 409, error: 'already_published' };
    return { status: 409, error: 'already_publishing' };
  }

  // Cancel. Also clears away a failed or rejected post — nothing to protect
  // there. A published one stays: the record of what went out is not ours
  // to lose, and removing it here would not remove it from Instagram.
  app.delete('/api/scheduled-posts/:id', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const removed = await queryOne<{ id: string }>(
      db,
      `DELETE FROM scheduled_posts
       WHERE id = ? AND tenant_id = ? AND (${CHANGEABLE} OR status IN ('failed', 'rejected'))
       RETURNING id`,
      req.params.id,
      tenantId
    );
    if (removed) return res.status(204).end();
    const why = await whyNotChangeable(req.params.id, tenantId);
    res.status(why.status).json({ error: why.error });
  }));

  // Edit the words, the time or the account. The platform and the video are
  // what the post is; changing those is a new post.
  app.patch('/api/scheduled-posts/:id', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const post = await getScheduledPostForTenant(db, req.params.id, tenantId);
    if (!post) return res.status(404).json({ error: 'post not found' });

    const body = req.body ?? {};
    const caption = body.caption === undefined ? post.caption : body.caption;
    if (typeof caption !== 'string' || !caption.trim()) return res.status(400).json({ error: 'caption is required' });
    const scheduledAt = body.scheduledAt === undefined ? post.scheduled_at : body.scheduledAt;
    if (Number.isNaN(Date.parse(scheduledAt))) return res.status(400).json({ error: 'scheduledAt must be a valid date' });
    const accountId = body.platformAccountId === undefined ? post.platform_account_id : body.platformAccountId;
    if (accountId !== null && typeof accountId !== 'string') return res.status(400).json({ error: 'platformAccountId must be a string or null' });
    if (accountId && accountId !== post.platform_account_id) {
      const refused = await refusePostAccount(tenantId, accountId, post.platform);
      if (refused) return res.status(refused.status).json({ error: refused.error });
    }

    // A post waiting out our pace or Instagram's limit goes back to plain
    // "scheduled": its new time is the one to wait for now.
    const updated = await queryOne<{ id: string }>(
      db,
      `UPDATE scheduled_posts
       SET caption = ?, scheduled_at = ?, platform_account_id = ?,
           status = CASE WHEN status = 'publishing' THEN 'scheduled' ELSE status END,
           waiting_reason = NULL, next_attempt_at = NULL
       WHERE id = ? AND tenant_id = ? AND ${CHANGEABLE}
       RETURNING id`,
      caption.trim(),
      new Date(scheduledAt).toISOString(),
      accountId,
      post.id,
      tenantId
    );
    if (!updated) {
      const why = await whyNotChangeable(post.id, tenantId);
      return res.status(why.status).json({ error: why.error });
    }
    const fresh = await getScheduledPostForTenant(db, post.id, tenantId);
    res.json({ post: fresh && postForClient(fresh) });
  }));

  // Try a failed post again — after reconnecting the account, say — without
  // building it from scratch. It goes out as soon as the publisher next runs.
  //
  // One case is not a fresh start: a post that failed AT the publish call may
  // in fact be live, its answer lost. That one keeps its container and stage,
  // so the next pass asks Instagram first and only records it if it is
  // already published — the same guard as an ordinary retry.
  app.post('/api/scheduled-posts/:id/retry', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const post = await getScheduledPostForTenant(db, req.params.id, tenantId);
    if (!post) return res.status(404).json({ error: 'post not found' });
    if (post.status !== 'failed') return res.status(409).json({ error: 'not_failed' });
    if (!post.video_object_key) return res.status(409).json({ error: 'no_video' });
    if (post.platform_account_id) {
      const refused = await refusePostAccount(tenantId, post.platform_account_id, post.platform);
      // The post exists and is ours; what is missing is a usable account.
      if (refused) return res.status(409).json({ error: refused.status === 404 ? 'account_unavailable' : refused.error });
    }

    const resumeAtPublish = post.publish_stage === 'publishing' && Boolean(post.ig_container_id);
    const now = new Date().toISOString();
    const retried = await queryOne<{ id: string }>(
      db,
      resumeAtPublish
        ? `UPDATE scheduled_posts
           SET status = 'publishing', claimed_at = NULL, next_attempt_at = ?, attempts = 0,
               failure_reason = NULL, failure_detail = NULL, waiting_reason = NULL
           WHERE id = ? AND tenant_id = ? AND status = 'failed'
           RETURNING id`
        : `UPDATE scheduled_posts
           SET status = 'scheduled', scheduled_at = ?, claimed_at = NULL, next_attempt_at = NULL, attempts = 0,
               failure_reason = NULL, failure_detail = NULL, waiting_reason = NULL,
               ig_container_id = NULL, publish_stage = NULL, container_created_at = NULL
           WHERE id = ? AND tenant_id = ? AND status = 'failed'
           RETURNING id`,
      now,
      post.id,
      tenantId
    );
    if (!retried) return res.status(409).json({ error: 'not_failed' });
    const fresh = await getScheduledPostForTenant(db, post.id, tenantId);
    res.json({ post: fresh && postForClient(fresh) });
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

  // ---- Erasing the account ------------------------------------------------
  // The customer's own right to erasure (Kazakhstan's personal data law):
  // the whole workspace, every row and every file, on the owner's request.
  //
  // Owner-only (roles.ts), a signed-in person rather than an API key, and the
  // password asked again: this cannot be undone, and a session left open on
  // a shared computer must not be enough to do it. Rate-limited like sign-in,
  // because a password check is a password check.
  app.delete('/api/account', authRateLimit, asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const session = res.locals.session as { userId: string } | undefined;
    if (!session) return res.status(403).json({ error: 'Удалить аккаунт может только владелец, вошедший по паролю' });
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = await queryOne<{ password_hash: string }>(db, `SELECT password_hash FROM users WHERE id = ? AND tenant_id = ?`, session.userId, tenantId);
    if (!user || !password || !(await verifyPassword(password, user.password_hash))) {
      // 403, not 401: the session is valid, and the page treats a 401 as
      // "signed out" — a typo would otherwise end the session.
      return res.status(403).json({ error: 'Неверный пароль' });
    }

    const { objectKeys } = await eraseAccount(db, tenantId);

    // After the rows are gone, and never fatal: see accountDeletion.ts.
    const storage = storageConfigFromEnv();
    for (const key of objectKeys) {
      const removal = storage
        ? deleteObject(storage, key)
        : localMedia
          ? fsp.rm(resolveKeyPath(localMedia, key), { force: true })
          : Promise.resolve();
      await removal.catch((err: unknown) =>
        console.warn(`[account] ${tenantId}: file not removed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
    if (localMedia) {
      await fsp.rm(resolveKeyPath(localMedia, `tenants/${tenantId}`), { recursive: true, force: true }).catch(() => {});
    }

    clearSessionCookie(res);
    res.status(204).end();
  }));

  // ---- Module 5: connected accounts -------------------------------------
  // Writes are owner-only (roles.ts). Nothing here returns a token: the list
  // carries who and until when, which is all a screen needs.

  app.get('/api/platform-accounts', asyncHandler(async (_req, res) => {
    res.json({
      accounts: await listAccounts(db, res.locals.tenantId as string),
      // Said separately, so the screen can tell "nothing connected yet" from
      // "connecting is not possible yet" — different things to tell a person.
      instagramAvailable: Boolean(instagram && tokenKeyring),
      testConnectAvailable: MOCK_CONNECT_AVAILABLE,
    });
  }));

  app.post('/api/platform-accounts/instagram/connect', asyncHandler(async (_req, res) => {
    if (!tokenKeyring) return res.status(503).json({ error: 'token_vault_not_configured' });
    if (!instagram) return res.status(503).json({ error: 'instagram_not_configured' });
    res.json({ authorizeUrl: authorizeUrl(instagram, signState(oauthStateKey, res.locals.tenantId as string)) });
  }));

  // The development stand-in, same idea as the mock webhook: the whole path —
  // connect, list, disconnect — exercised without Meta. No token worth the
  // name, never refreshed, labelled as a test on the screen, and absent from
  // production.
  app.post('/api/platform-accounts/test', asyncHandler(async (_req, res) => {
    if (!MOCK_CONNECT_AVAILABLE) return res.status(404).json({ error: 'not_found' });
    if (!tokenKeyring) return res.status(503).json({ error: 'token_vault_not_configured' });
    const account = await saveConnectedAccount(db, tokenKeyring, res.locals.tenantId as string, 'instagram', {
      userId: 'test-account',
      username: 'test_blogger',
      accessToken: 'test-token',
      expiresAt: new Date(),
      isTest: true,
    });
    res.status(201).json({ account });
  }));

  // Disconnecting forgets the token. Revoking the app's access on
  // Instagram's side is the person's to do in their Instagram settings —
  // there is no API for an app to revoke itself there.
  app.delete('/api/platform-accounts/:id', asyncHandler(async (req, res) => {
    const removed = await queryOne<{ id: string }>(
      db,
      `DELETE FROM platform_accounts WHERE id = ? AND tenant_id = ? RETURNING id`,
      req.params.id,
      res.locals.tenantId
    );
    if (!removed) return res.status(404).json({ error: 'account not found' });
    res.status(204).end();
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

  // Topics read from what buyers asked (contentTopics.ts). The saved plan and
  // what the workspace has so far, together: the screen needs both to decide
  // between showing topics, offering to make them, and explaining what is
  // still missing.
  app.get('/api/content-plan', asyncHandler(async (_req, res) => {
    const tenantId = res.locals.tenantId as string;
    res.json({ plan: await getContentPlan(db, tenantId), readiness: await planReadiness(db, tenantId) });
  }));

  // Made on request, not on view — a model call per page load would be paid
  // for by every refresh. Same model as the reel scripts.
  app.post('/api/content-plan', aiRateLimit, asyncHandler(async (_req, res) => {
    try {
      res.json({ plan: await generateContentPlan(db, res.locals.tenantId as string, reelChat) });
    } catch (err) {
      if (err instanceof NotEnoughDataError) return res.status(409).json({ error: 'not_enough_data' });
      if (err instanceof ReelAnalysisError) return res.status(err.reason === 'llm_not_configured' ? 503 : 502).json({ error: err.reason });
      throw err;
    }
  }));

  app.post('/api/content-plan/topics/:id/script', aiRateLimit, asyncHandler(async (req, res) => {
    try {
      const topic = await writeTopicScript(db, res.locals.tenantId as string, req.params.id, reelChat);
      if (!topic) return res.status(404).json({ error: 'topic not found' });
      res.json({ topic });
    } catch (err) {
      if (err instanceof ReelAnalysisError) return res.status(err.reason === 'llm_not_configured' ? 503 : 502).json({ error: err.reason });
      throw err;
    }
  }));

  // ---- Module 6: the calendar ------------------------------------------
  // Dates are the browser's: see contentCalendar.ts.

  app.get('/api/content-calendar', asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    if (!isDay(from) || !isDay(to) || to < from) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD, from first' });
    // A couple of months at most: the screen shows a week, and an unbounded
    // range is a full-table read on request.
    if (addDays(from, 62) < to) return res.status(400).json({ error: 'range too long' });
    res.json({ entries: await listEntries(db, res.locals.tenantId as string, from, to) });
  }));

  app.post('/api/content-calendar/auto', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const weekStart = req.body?.weekStart;
    const perWeek = Number(req.body?.perWeek ?? 3);
    if (!isDay(weekStart)) return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
    if (!Number.isInteger(perWeek) || perWeek < 1 || perWeek > 7) return res.status(400).json({ error: 'perWeek must be 1..7' });
    // The browser's today, for the same reason the days are the browser's.
    const today = isDay(req.body?.today) ? req.body.today : undefined;
    const plan = await getContentPlan(db, tenantId);
    if (!plan || plan.topics.length === 0) return res.status(409).json({ error: 'no_plan' });
    res.json({ entries: await autoFillWeek(db, tenantId, plan.topics, weekStart, perWeek, today) });
  }));

  app.patch('/api/content-calendar/:id', asyncHandler(async (req, res) => {
    if (!isDay(req.body?.day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    const moved = await queryOne<{ id: string }>(
      db,
      `UPDATE content_calendar SET day = ?::date WHERE id = ? AND tenant_id = ? RETURNING id`,
      req.body.day,
      req.params.id,
      res.locals.tenantId
    );
    if (!moved) return res.status(404).json({ error: 'entry not found' });
    res.json({ ok: true });
  }));

  app.delete('/api/content-calendar/:id', asyncHandler(async (req, res) => {
    const removed = await queryOne<{ id: string }>(
      db,
      `DELETE FROM content_calendar WHERE id = ? AND tenant_id = ? RETURNING id`,
      req.params.id,
      res.locals.tenantId
    );
    if (!removed) return res.status(404).json({ error: 'entry not found' });
    res.status(204).end();
  }));

  // A script for an entry. Through its topic when the plan still has it, so
  // the topic card shows the script too; from the entry's own words when a
  // rebuilt plan no longer does.
  app.post('/api/content-calendar/:id/script', aiRateLimit, asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const entry = await queryOne<{ id: string; topic_id: string | null; title: string; segment: string }>(
      db,
      `SELECT id, topic_id, title, segment FROM content_calendar WHERE id = ? AND tenant_id = ?`,
      req.params.id,
      tenantId
    );
    if (!entry) return res.status(404).json({ error: 'entry not found' });
    try {
      const viaTopic = entry.topic_id ? await writeTopicScript(db, tenantId, entry.topic_id, reelChat) : null;
      const script = viaTopic?.script ?? (await scriptFor(entry, reelChat));
      if (!viaTopic) await exec(db, `UPDATE content_calendar SET script = ? WHERE id = ?`, script, entry.id);
      res.json({ script });
    } catch (err) {
      if (err instanceof ReelAnalysisError) return res.status(err.reason === 'llm_not_configured' ? 503 : 502).json({ error: err.reason });
      throw err;
    }
  }));

  // ---- Module 8: Video editing, Levels 1-2 (mocked Shotstack/Creatomate) --

  const VIDEO_TEMPLATES: VideoTemplate[] = ['auto_crop_916', 'template_with_transitions', 'ai_smart_cut'];

  // Level 3 needs the actual file, which the Level 1-2 presets never did
  // (they take a URL string). The browser uploads straight to object storage
  // with this presigned URL — the API never sees the bytes, because proxying
  // a few hundred megabytes of video through an Express process on a small
  // instance is what takes the whole API down.
  app.post('/api/video-uploads', uploadRateLimit, asyncHandler(async (req, res) => {
    const storage = storageConfigFromEnv();
    if (!storage && !localMedia) return res.status(503).json({ error: 'storage_not_configured' });

    const contentType = typeof req.body?.contentType === 'string' ? req.body.contentType : '';
    if (!UPLOAD_CONTENT_TYPES.includes(contentType)) {
      return res.status(400).json({ error: `contentType must be one of: ${UPLOAD_CONTENT_TYPES.join(', ')}` });
    }
    // Said at once, before minutes of uploading. Only a courtesy: a presigned
    // PUT cannot hold the browser to the size it declares, which is why the
    // worker enforces the same ceiling as it downloads (storage.ts).
    const size = Number(req.body?.size);
    if (Number.isFinite(size) && size > MAX_SOURCE_BYTES) {
      return res.status(413).json({ error: `Файл больше ${MAX_SOURCE_BYTES / 1024 / 1024} МБ — загрузите ролик покороче или сожмите его` });
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

  app.post('/api/video-edit-jobs', mediaRateLimit, asyncHandler(async (req, res) => {
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
      // The three axes that ride on top of the preset. Each falls back to
      // 'auto' (or the neutral 'medium'), which means "leave the preset
      // alone" — so a client that does not know about them yet gets exactly
      // what it got before.
      const subtitleFont = isSubtitleFontId(req.body?.subtitleFont) ? req.body.subtitleFont : DEFAULT_SUBTITLE_FONT;
      const subtitleColor = isSubtitleColourId(req.body?.subtitleColor) ? req.body.subtitleColor : DEFAULT_SUBTITLE_COLOUR;
      const subtitleSize = isSubtitleSizeId(req.body?.subtitleSize) ? req.body.subtitleSize : DEFAULT_SUBTITLE_SIZE;
      // Opt-in: the most destructive pass in the pipeline, and on a noisy
      // recording it finds nothing anyway.
      const removeBreaths = req.body?.removeBreaths === true;
      // Same fallback as the caption ids, and for the same reason: a stale
      // client naming a format that no longer exists should get the vertical
      // one the product was built around, not a 400.
      const aspectRatio = isAspectRatioId(req.body?.aspectRatio) ? req.body.aspectRatio : DEFAULT_ASPECT_RATIO;
      // Stored already cleaned, so the renderer is not the last line of defence
      // against a brace that would break out of an ASS override block. Empty
      // becomes NULL rather than '': no headline and a headline of nothing are
      // the same thing, and one of the two spellings would otherwise reserve a
      // band for blank space.
      const headline =
        typeof req.body?.headline === 'string' ? sanitizeHeadline(req.body.headline) || null : null;
      // Ids from a closed list, never a font name or a hex colour: an
      // unresolvable family is replaced by libass without a word, and a dark
      // colour disappears into the black band.
      const headlineFontId = isHeadlineFontId(req.body?.headlineFont) ? req.body.headlineFont : DEFAULT_HEADLINE_FONT;
      const headlineSizeId = isHeadlineSizeId(req.body?.headlineSize) ? req.body.headlineSize : DEFAULT_HEADLINE_SIZE;
      const headlineColourId = isHeadlineColourId(req.body?.headlineColor) ? req.body.headlineColor : DEFAULT_HEADLINE_COLOUR;

      const id = randomUUID();
      await exec(
        db,
        `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, source_object_key, subtitles, denoise_mode, review_mode, subtitle_preset, subtitle_position, subtitle_font, subtitle_color, subtitle_size, headline, headline_font, headline_size, headline_color, remove_breaths, aspect_ratio) VALUES (?, ?, ?, ?, 'smart_cut', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        subtitleFont,
        subtitleColor,
        subtitleSize,
        headline,
        headlineFontId,
        headlineSizeId,
        headlineColourId,
        removeBreaths,
        aspectRatio
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
              output_object_key, parent_job_id,
              artifacts - 'transcript' AS artifacts
       FROM video_edit_jobs
       -- Previews are a question being answered, not work anyone ordered:
       -- four seconds each, one per style someone tries. Left in, they would
       -- bury the renders the queue exists to show.
       WHERE tenant_id = ? AND preview_of IS NULL
       ORDER BY created_at DESC, seq DESC`,
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

  // Everything the cut editor needs, in one request. Separate from the job
  // GET above because that one is polled every couple of seconds while a
  // render runs, and signing a source URL on each of those polls would be
  // work for a screen that is not open.
  app.get('/api/video-edit-jobs/:id/editor', asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const job = await getVideoJobForTenant(db, req.params.id, tenantId);
    if (!job) return res.status(404).json({ error: 'not_found' });
    const { probe, transcript, plan } = job.artifacts;
    if (!probe || !transcript) return res.status(409).json({ error: 'nothing_to_revise_from' });

    const storage = storageConfigFromEnv();
    // The source, not the render: the editor has to show the footage the cuts
    // were made FROM, including the parts the planner threw away — those are
    // exactly the ones a person reaches for when the automatic cut took out
    // something it should have kept.
    const sourceUrl =
      storage && job.source_object_key
        ? presign(storage, { method: 'GET', key: job.source_object_key, expiresInSec: EDITOR_SOURCE_TTL_SEC })
        : job.source_video_url;

    res.json({
      duration_sec: probe.durationSec,
      // What is on screen now — the automatic plan, or the segments the last
      // edit drew. Either way it is where the editor's handles start.
      segments: job.manual_segments ?? plan?.segments ?? [{ start: 0, end: probe.durationSec }],
      // Timed words, so the editor can show what is being said under the
      // playhead instead of asking someone to find a sentence boundary by ear.
      words: transcript.words,
      source_url: sourceUrl,
      // The render being edited, captions and headline burned in. The source
      // player cannot show either — they exist only in this file — so without
      // it someone changing a caption style is choosing blind until the
      // revision comes back. Null on a job that never produced one.
      result_url: job.output_url,
      manual: job.manual_segments !== null,
      // What this render was made with, so the editor's controls open showing
      // the truth rather than the defaults. Sending them back is also what
      // lets a revision change one of them without resetting the rest.
      style: {
        subtitles: job.subtitles,
        subtitlePreset: job.subtitle_preset,
        subtitlePosition: job.subtitle_position,
        subtitleFont: job.subtitle_font,
        subtitleColor: job.subtitle_color,
        subtitleSize: job.subtitle_size,
        aspectRatio: job.aspect_ratio,
        headline: job.headline,
        headlineFont: job.headline_font,
        headlineSize: job.headline_size,
        headlineColor: job.headline_color,
      },
    });
  }));

  // A few seconds of this video, rendered with a caption look, so choosing a
  // style stops being a guess. The alternative — drawing the captions in the
  // browser — would mean a second implementation of ASS in CSS, and two
  // implementations drift: the preview would eventually show something the
  // renderer does not produce, which is worse than showing nothing.
  //
  // Costs no transcription. The parent's is inherited, so this is a few
  // seconds of ffmpeg and nothing else.
  app.post('/api/video-edit-jobs/:id/preview', previewRateLimit, asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const parent = await queryOne<VideoEditJob>(
      db,
      `SELECT * FROM video_edit_jobs WHERE id = ? AND tenant_id = ?`,
      req.params.id,
      tenantId
    );
    if (!parent) return res.status(404).json({ error: 'not_found' });
    if (parent.pipeline !== 'smart_cut') return res.status(409).json({ error: 'not_a_smart_cut_job' });

    const { probe, transcript, noise } = parent.artifacts;
    if (!probe || !transcript) return res.status(409).json({ error: 'nothing_to_revise_from' });
    if (!parent.source_object_key) return res.status(409).json({ error: 'source_gone' });

    // Previewed against the cut currently on screen, not the one that was
    // rendered: the person may have redrawn it, and a preview of the old
    // boundaries would answer a question nobody asked.
    const drawn = Array.isArray(req.body?.segments) ? req.body.segments : null;
    const segments = drawn
      ? normalizeManualSegments(drawn, probe.durationSec)
      : (parent.manual_segments ?? parent.artifacts.plan?.segments ?? [{ start: 0, end: probe.durationSec }]);
    if (!segments) return res.status(400).json({ error: 'segments_invalid' });

    const window = pickPreviewWindow(segments, transcript.words, PREVIEW_SECONDS);
    // Nothing worth showing: the cut kept no speech at all. Rendering four
    // silent seconds would look like the captions are broken rather than like
    // there is nothing to caption.
    if (!window) return res.status(409).json({ error: 'no_speech_to_preview' });

    const look = captionLookFrom(req.body ?? {}, parent);
    const id = randomUUID();
    await exec(
      db,
      `INSERT INTO video_edit_jobs (
         id, tenant_id, source_video_url, template, pipeline, source_object_key,
         subtitles, denoise_mode, review_mode, subtitle_preset, subtitle_position,
         subtitle_font, subtitle_color, subtitle_size,
         headline, headline_font, headline_size, headline_color, remove_breaths, aspect_ratio,
         preview_of, manual_segments, artifacts
       ) VALUES (?, ?, ?, ?, 'smart_cut', ?, ?, ?, 'never', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`,
      id,
      tenantId,
      parent.source_video_url,
      parent.template,
      parent.source_object_key,
      look.subtitles,
      parent.denoise_mode,
      look.subtitlePreset,
      look.subtitlePosition,
      look.subtitleFont,
      look.subtitleColor,
      look.subtitleSize,
      look.headline,
      look.headlineFont,
      look.headlineSize,
      look.headlineColor,
      // Never: the breath pass decodes the whole audio track a second time,
      // which is minutes of work to shave hundredths off four seconds nobody
      // is going to publish.
      false,
      look.aspectRatio,
      parent.id,
      JSON.stringify(window),
      JSON.stringify({ probe, transcript, ...(noise ? { noise } : {}) })
    );

    res.status(201).json({ job: await getVideoJobForTenant(db, id, tenantId) });
  }));

  // Re-edit: the automatic cut was wrong, and this is the person saying where
  // the cuts actually go. Creates a NEW job rather than re-running this one —
  // the render they are looking at stays downloadable while the revision
  // works, and survives one that comes out worse or fails.
  app.post('/api/video-edit-jobs/:id/revise', mediaRateLimit, asyncHandler(async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const parent = await queryOne<VideoEditJob>(
      db,
      `SELECT * FROM video_edit_jobs WHERE id = ? AND tenant_id = ?`,
      req.params.id,
      tenantId
    );
    if (!parent) return res.status(404).json({ error: 'not_found' });
    if (parent.pipeline !== 'smart_cut') return res.status(409).json({ error: 'not_a_smart_cut_job' });
    // A job still working has no result to disagree with yet, and letting a
    // second render start from the same source would have two workers holding
    // leases on the same edit.
    if (parent.status === 'processing' || parent.status === 'awaiting_review') {
      return res.status(409).json({ error: 'job_still_running' });
    }

    // The whole saving of a revision is that these two are already paid for:
    // the probe gives the duration the segments are measured against, and the
    // transcript is the only stage that costs money. Without them there is
    // nothing to revise from — the original never got far enough.
    const { probe, transcript, noise } = parent.artifacts;
    if (!probe || !transcript) return res.status(409).json({ error: 'nothing_to_revise_from' });
    if (!parent.source_object_key) return res.status(409).json({ error: 'source_gone' });

    const incoming = Array.isArray(req.body?.segments) ? req.body.segments : null;
    if (!incoming) return res.status(400).json({ error: 'segments_required' });
    const segments = normalizeManualSegments(incoming, probe.durationSec);
    // Refused rather than repaired: an empty or oversized list means the
    // editor sent something that does not describe a video, and guessing what
    // was meant is how a person ends up with a render they did not draw.
    if (!segments) return res.status(400).json({ error: 'segments_invalid' });

    // Everything the person could also have changed while they were in there.
    // Absent means "same as before", which is why each one falls back to the
    // parent's value rather than to the system default — a revision that
    // quietly reset the caption style to Классика because the editor did not
    // mention it would be a worse bug than the one it came to fix.
    const body = req.body ?? {};
    const look = captionLookFrom(body, parent);
    const {
      subtitles,
      subtitlePreset,
      subtitlePosition,
      aspectRatio,
      subtitleFont,
      subtitleColor,
      subtitleSize,
    } = look;
    const { headline, headlineFont, headlineSize, headlineColor } = look;

    // Corrected words — how a misheard name gets fixed. Only the text is
    // taken; the timings stay the pipeline's, exactly as the caption review
    // does it, because a client-supplied timing would desynchronise the
    // captions from the video. Same length required for the same reason:
    // this is a correction of what was heard, not a different transcript.
    //
    // Stored against the SOURCE timeline rather than as caption lines, which
    // is what makes it survive this edit's new cut: captions are rebuilt from
    // these words against whatever segments were drawn, so fixing a word and
    // moving a boundary in one pass cannot desynchronise them.
    let revisedTranscript = transcript;
    if (Array.isArray(body.words)) {
      if (body.words.length !== transcript.words.length) {
        return res.status(400).json({ error: 'words_length_mismatch' });
      }
      revisedTranscript = {
        ...transcript,
        words: transcript.words.map((word, i) => ({
          ...word,
          word: typeof body.words[i] === 'string' ? body.words[i].trim().slice(0, 100) : word.word,
        })),
      };
    }

    const id = randomUUID();
    await exec(
      db,
      `INSERT INTO video_edit_jobs (
         id, tenant_id, source_video_url, template, pipeline, source_object_key,
         subtitles, denoise_mode, review_mode, subtitle_preset, subtitle_position,
         subtitle_font, subtitle_color, subtitle_size,
         headline, headline_font, headline_size, headline_color, remove_breaths, aspect_ratio,
         parent_job_id, manual_segments, artifacts
       ) VALUES (?, ?, ?, ?, 'smart_cut', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`,
      id,
      tenantId,
      parent.source_video_url,
      parent.template,
      parent.source_object_key,
      subtitles,
      parent.denoise_mode,
      // Never 'auto' or 'always', whatever the parent said: the pause exists
      // to ask a person to check the machine's work, and a person is what
      // just produced this edit. Stopping to ask them again would be asking
      // them to approve their own typing.
      'never',
      subtitlePreset,
      subtitlePosition,
      subtitleFont,
      subtitleColor,
      subtitleSize,
      headline,
      headlineFont,
      headlineSize,
      headlineColor,
      parent.remove_breaths,
      aspectRatio,
      parent.id,
      JSON.stringify(segments),
      // Exactly the three checkpoints that describe the SOURCE rather than the
      // cut. The plan, the captions and the subtitle counts all belong to the
      // edit being replaced. `breaths` and `speechTiming` are dropped too:
      // both are inputs to a planner this job will not run, and carrying them
      // over would have the card claim passes that never happened. `usage` is
      // dropped because this render genuinely spends nothing on transcription
      // and copying it would bill the same audio twice.
      JSON.stringify({ probe, transcript: revisedTranscript, ...(noise ? { noise } : {}) })
    );

    res.status(201).json({ job: await getVideoJobForTenant(db, id, tenantId) });
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
  // A sender's name and handle as the event gives them — trimmed, capped, and
  // dropped when blank. The handle loses a leading "@" and anything Instagram
  // would not allow in one, since it is shown back as "@handle" and a stray
  // character there reads as the person's real name being wrong.
  function parseContactProfile(body: unknown): ContactProfile {
    const b = (body ?? {}) as { name?: unknown; username?: unknown };
    const displayName = typeof b.name === 'string' ? b.name.trim().slice(0, 100) : '';
    const username = typeof b.username === 'string' ? b.username.trim().replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 30) : '';
    return { ...(displayName ? { displayName } : {}), ...(username ? { username } : {}) };
  }

  // Shared by the two entry points below: the public mock webhook (Meta's
  // stand-in) and the authenticated in-product simulator. Both must apply
  // the same event_id dedup contract that the real POST /webhooks/instagram
  // will, so the logic lives in one place rather than being duplicated.
  async function handleIncomingMessage(
    bot: Bot,
    eventId: string,
    externalUserId: string,
    messageText: string,
    rawPayload: unknown,
    profile: ContactProfile = {}
  ): Promise<{ status: 'already_processed' } | { outcome: Awaited<ReturnType<typeof runFlow>> }> {
    const claimed = await tryClaimWebhookEvent(db, eventId, bot.id, rawPayload);
    if (!claimed) return { status: 'already_processed' };

    const outcome = await runFlow(db, {
      tenantId: bot.tenant_id,
      botId: bot.id,
      externalUserId,
      messageText,
      profile,
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
    const profile = parseContactProfile(req.body);
    const result = await handleIncomingMessage(bot, eventId, externalUserId, messageText, {
      source: 'in_product_simulator',
      eventId,
      externalUserId,
      messageText,
    }, profile);
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

    res.json(await handleIncomingMessage(bot, eventId, externalUserId, messageText, req.body, parseContactProfile(req.body)));
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
  // Postgres class 22 — data exceptions: text where a number was expected, a
  // number out of range, an impossible date. Each is a value the caller sent
  // that a route did not check, and so the caller's error, not the server's.
  // The backstop for the routes the input checks above do not yet cover.
  const pgCode = (err as { code?: unknown }).code;
  if (typeof pgCode === 'string' && /^22[0-9A-Z]{3}$/.test(pgCode)) return 400;
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
        // A tenant API key is the workspace itself, not a person in it, and it
        // is issued by a staff-only route. Treating it as an owner keeps every
        // existing integration working exactly as before roles existed.
        res.locals.role = 'owner';
        return next();
      }

      const session = verifySession(credential);
      if (session.ok) {
        // A correctly signed token for a user/tenant pair that no longer
        // exists is not a valid current product session.
        // The role is read here rather than carried in the token: a token
        // lives a week, and a demotion that only takes effect when it expires
        // is not a demotion. This row is already being fetched, so it costs
        // nothing.
        const user = await queryOne<{ id: string; role: string }>(
          db,
          `SELECT id, role FROM users WHERE id = ? AND tenant_id = ?`,
          session.payload.userId,
          session.payload.tenantId
        );
        if (user) {
          res.locals.tenantId = session.payload.tenantId;
          res.locals.session = session.payload;
          res.locals.role = asRole(user.role);
          return next();
        }
      }

      return res.status(401).json({ error: 'invalid_api_key' });
    } catch (err) {
      next(err);
    }
  };
}

// Default-deny by method (src/roles.ts), mounted straight after the
// credential check so that everything past this line is covered — including
// routes nobody has written yet.
//
// 403 with the role that was needed, not a bare refusal: the person is
// legitimately signed in, and "нет прав" without saying whose rights would
// leave them retrying the same thing.
function requireRoleForRequest(req: Request, res: Response, next: NextFunction) {
  const role = asRole(res.locals.role);
  // baseUrl + path, and neither one alone. Express strips the mount point from
  // req.path, so inside a handler mounted at '/api' it reads '/bots' — every
  // rule below is written against '/api/bots' and would simply never match,
  // silently collapsing three roles into "can write". originalUrl would carry
  // the full path but also the query string, which must not be able to steer
  // which rule applies.
  const fullPath = `${req.baseUrl}${req.path}`;
  if (canPerform(role, req.method, fullPath)) return next();
  const needed = requiredRole(req.method, fullPath);
  return res.status(403).json({
    error: 'insufficient_role',
    role,
    requiredRole: needed,
    message: `Нужна роль «${ROLE_LABELS[needed]}», у вас «${ROLE_LABELS[role]}»`,
  });
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
//
// Except once it is genuinely on its way: a reel Instagram is transcoding, or
// one waiting out a limit, can sit there for minutes or an hour, and
// "Запланировано" past its own time would read as stuck.
function toPublicScheduledPost(post: ScheduledPost): ScheduledPost {
  if (post.status !== 'publishing') return post;
  return post.publish_stage || post.waiting_reason ? post : { ...post, status: 'scheduled' };
}

// How a caption should look, resolved from what a request asked for against
// what the job being edited already had.
//
// Shared by the revision and the preview so the two cannot drift: a preview
// that resolved a missing field differently from the render it is previewing
// would be showing the wrong thing, which is the one failure a preview must
// not have.
//
// Absent means "same as before" throughout, never "system default". A
// revision that reset the caption style to Классика because the editor did
// not mention it would be a worse bug than the one it came to fix.
function captionLookFrom(body: Record<string, unknown>, parent: VideoEditJob) {
  return {
    subtitles: typeof body.subtitles === 'boolean' ? body.subtitles : parent.subtitles,
    subtitlePreset: isSubtitlePresetId(body.subtitlePreset) ? body.subtitlePreset : parent.subtitle_preset,
    subtitlePosition: isSubtitlePositionId(body.subtitlePosition)
      ? body.subtitlePosition
      : parent.subtitle_position,
    aspectRatio: isAspectRatioId(body.aspectRatio) ? body.aspectRatio : parent.aspect_ratio,
    subtitleFont: isSubtitleFontId(body.subtitleFont) ? body.subtitleFont : parent.subtitle_font,
    subtitleColor: isSubtitleColourId(body.subtitleColor) ? body.subtitleColor : parent.subtitle_color,
    subtitleSize: isSubtitleSizeId(body.subtitleSize) ? body.subtitleSize : parent.subtitle_size,
    // Present-but-empty is how a headline is removed, which is different from
    // not mentioning it at all — so this one cannot use the same shape as the
    // rest.
    headline:
      body.headline === undefined
        ? parent.headline
        : typeof body.headline === 'string'
          ? sanitizeHeadline(body.headline) || null
          : null,
    headlineFont: isHeadlineFontId(body.headlineFont) ? body.headlineFont : parent.headline_font,
    headlineSize: isHeadlineSizeId(body.headlineSize) ? body.headlineSize : parent.headline_size,
    headlineColor: isHeadlineColourId(body.headlineColor) ? body.headlineColor : parent.headline_color,
  };
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
