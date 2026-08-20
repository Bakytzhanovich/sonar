import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createApiKeyForTenant, resolveTenantIdFromApiKey } from './apiKeys';
import { runFlow, collectMessageNodes } from './flowEngine';
import { analyzeReelMock, generateScriptMock } from './reelAnalysis';
import { generateCarouselMock } from './carouselGeneration';
import { publishDuePosts } from './publisher';
import { computeContentRecommendations } from './contentRecommendations';
import { advanceRenderJobs } from './videoRender';
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
  VideoEditJob,
  VideoTemplate,
} from './types';

export function createApp(db: Database.Database): Express {
  const app = express();
  app.use(express.json());

  // Permissive for now — every protected route needs a Bearer API key, not
  // a cookie/session, so there's no CSRF surface to widen by allowing any
  // origin. Worth tightening to a specific origin once there's a real
  // deployed frontend URL to pin it to.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // ---- Tenant bootstrap (not API-key protected — this is how a tenant
  // gets its first key; equivalent to a signup step). --------------------
  app.post('/api/tenants', (req, res) => {
    const { name, email } = req.body ?? {};
    if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

    const tenantId = randomUUID();
    db.prepare(`INSERT INTO tenants (id, name, email) VALUES (?, ?, ?)`).run(tenantId, name, email);
    const apiKey = createApiKeyForTenant(db, tenantId);

    // apiKey is shown exactly once, right here — it is not retrievable
    // again (only its hash is stored).
    res.status(201).json({ tenant: { id: tenantId, name, email }, apiKey });
  });

  app.use('/api', requireApiKey(db));

  // ---- Bots --------------------------------------------------------------
  app.post('/api/bots', (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const { name, platform, externalAccountId } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const botId = randomUUID();
    db.prepare(
      `INSERT INTO bots (id, tenant_id, name, platform, external_account_id) VALUES (?, ?, ?, ?, ?)`
    ).run(botId, tenantId, name, platform ?? 'instagram', externalAccountId ?? null);

    res.status(201).json({ bot: { id: botId, tenant_id: tenantId, name, platform: platform ?? 'instagram', external_account_id: externalAccountId ?? null } });
  });

  // ---- Flows ---------------------------------------------------------------
  app.post('/api/bots/:botId/flows', (req, res) => {
    const bot = getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const definition = req.body?.definition as FlowDefinition | undefined;
    if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
      return res.status(400).json({ error: 'definition with nodes[] and edges[] is required' });
    }

    const flowId = randomUUID();
    db.prepare(`INSERT INTO flows (id, bot_id, version, definition, status) VALUES (?, ?, 1, ?, 'draft')`).run(
      flowId,
      bot.id,
      JSON.stringify(definition)
    );

    res.status(201).json({ flow: { id: flowId, version: 1, status: 'draft' } });
  });

  // Lists every flow (each version as its own row) for a bot — what the
  // canvas uses to show "your flows" instead of requiring the caller to
  // remember a flowId after creating it.
  app.get('/api/bots/:botId/flows', (req, res) => {
    const bot = getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const flows = db
      .prepare(`SELECT id, version, status, created_at FROM flows WHERE bot_id = ? ORDER BY id, version DESC`)
      .all(bot.id);

    res.json({ flows });
  });

  // Fetches one specific version's definition — needed to re-open an
  // existing draft/published flow for editing; without this the canvas
  // could only ever create new flows, never load one back in.
  app.get('/api/flows/:flowId/versions/:version', (req, res) => {
    const version = Number(req.params.version);
    const row = db
      .prepare(
        `SELECT flows.id, flows.version, flows.definition, flows.status, bots.tenant_id
         FROM flows JOIN bots ON flows.bot_id = bots.id
         WHERE flows.id = ? AND flows.version = ?`
      )
      .get(req.params.flowId, version) as
      | { id: string; version: number; definition: string; status: string; tenant_id: string }
      | undefined;

    if (!row || row.tenant_id !== res.locals.tenantId) return res.status(404).json({ error: 'flow not found' });

    res.json({ flow: { id: row.id, version: row.version, status: row.status, definition: JSON.parse(row.definition) } });
  });

  // Publishing is where an invalid graph gets rejected — drafts can be
  // incomplete while being edited, but nothing incomplete can go live.
  app.post('/api/flows/:flowId/versions/:version/publish', (req, res) => {
    const version = Number(req.params.version);
    const row = db
      .prepare(
        `SELECT flows.definition, bots.tenant_id
         FROM flows JOIN bots ON flows.bot_id = bots.id
         WHERE flows.id = ? AND flows.version = ?`
      )
      .get(req.params.flowId, version) as { definition: string; tenant_id: string } | undefined;

    if (!row || row.tenant_id !== res.locals.tenantId) return res.status(404).json({ error: 'flow not found' });

    const definition = JSON.parse(row.definition) as FlowDefinition;
    const errors = validateFlowDefinition(definition);
    if (errors.length > 0) return res.status(422).json({ errors });

    db.prepare(`UPDATE flows SET status = 'published' WHERE id = ? AND version = ?`).run(req.params.flowId, version);
    res.json({ flow: { id: req.params.flowId, version, status: 'published' } });
  });

  // Adds a new draft version to an EXISTING flow (auto-incremented from
  // the current max version) — this is what makes rollback meaningful:
  // without a second version, there's nothing to roll back from.
  app.post('/api/flows/:flowId/versions', (req, res) => {
    const definition = req.body?.definition as FlowDefinition | undefined;
    if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
      return res.status(400).json({ error: 'definition with nodes[] and edges[] is required' });
    }

    const flowMeta = db
      .prepare(
        `SELECT flows.bot_id, bots.tenant_id, MAX(flows.version) as maxVersion
         FROM flows JOIN bots ON flows.bot_id = bots.id
         WHERE flows.id = ?
         GROUP BY flows.bot_id, bots.tenant_id`
      )
      .get(req.params.flowId) as { bot_id: string; tenant_id: string; maxVersion: number } | undefined;

    if (!flowMeta || flowMeta.tenant_id !== res.locals.tenantId) return res.status(404).json({ error: 'flow not found' });

    const nextVersion = flowMeta.maxVersion + 1;
    db.prepare(`INSERT INTO flows (id, bot_id, version, definition, status) VALUES (?, ?, ?, ?, 'draft')`).run(
      req.params.flowId,
      flowMeta.bot_id,
      nextVersion,
      JSON.stringify(definition)
    );

    res.status(201).json({ flow: { id: req.params.flowId, version: nextVersion, status: 'draft' } });
  });

  // ---- Triggers --------------------------------------------------------
  app.post('/api/bots/:botId/triggers', (req, res) => {
    const bot = getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const { keyword, matchType, flowId, flowVersion } = req.body ?? {};
    if (!keyword || !flowId || !flowVersion) {
      return res.status(400).json({ error: 'keyword, flowId and flowVersion are required' });
    }

    const flow = db
      .prepare(`SELECT status FROM flows WHERE id = ? AND version = ? AND bot_id = ?`)
      .get(flowId, flowVersion, bot.id) as { status: string } | undefined;

    if (!flow) return res.status(404).json({ error: 'flow not found on this bot' });
    if (flow.status !== 'published') {
      return res.status(422).json({ error: 'cannot bind a trigger to a flow that is not published' });
    }

    const triggerId = randomUUID();
    db.prepare(
      `INSERT INTO triggers (id, bot_id, flow_id, flow_version, keyword, match_type) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(triggerId, bot.id, flowId, flowVersion, keyword, matchType ?? 'contains');

    res.status(201).json({ trigger: { id: triggerId, bot_id: bot.id, flow_id: flowId, flow_version: flowVersion, keyword, match_type: matchType ?? 'contains' } });
  });

  // Points an existing trigger back at an earlier version of the same
  // flow. Doesn't touch flow rows or other triggers on the same flow —
  // triggers are bound per-version by design (see schema.sql), so rolling
  // one back can't silently change what any other trigger runs.
  app.post('/api/triggers/:triggerId/rollback', (req, res) => {
    const trigger = db
      .prepare(
        `SELECT triggers.*, bots.tenant_id as bot_tenant_id
         FROM triggers JOIN bots ON triggers.bot_id = bots.id
         WHERE triggers.id = ?`
      )
      .get(req.params.triggerId) as (Trigger & { bot_tenant_id: string }) | undefined;

    if (!trigger || trigger.bot_tenant_id !== res.locals.tenantId) return res.status(404).json({ error: 'trigger not found' });

    const toVersion = Number(req.body?.toVersion);
    if (!toVersion) return res.status(400).json({ error: 'toVersion is required' });

    const targetFlow = db.prepare(`SELECT status FROM flows WHERE id = ? AND version = ?`).get(trigger.flow_id, toVersion) as
      | { status: string }
      | undefined;

    if (!targetFlow) return res.status(404).json({ error: 'target flow version not found' });
    // Only ever-published versions are valid rollback targets — an
    // untested draft was never live, so "rolling back" to it would mean
    // something different (promoting unreviewed content), not a revert.
    if (targetFlow.status !== 'published') {
      return res.status(422).json({ error: 'can only roll back to a version that was published' });
    }

    db.prepare(`UPDATE triggers SET flow_version = ? WHERE id = ?`).run(toVersion, trigger.id);
    res.json({ trigger: { id: trigger.id, flow_id: trigger.flow_id, flow_version: toVersion } });
  });

  // ---- Test mode ---------------------------------------------------------
  app.post('/api/bots/:botId/test', (req, res) => {
    const bot = getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const { externalUserId, messageText } = req.body ?? {};
    if (!externalUserId || !messageText) {
      return res.status(400).json({ error: 'externalUserId and messageText are required' });
    }

    const outcome = runFlow(db, {
      tenantId: res.locals.tenantId as string,
      botId: bot.id,
      externalUserId,
      messageText,
      isTest: true,
    });

    res.json({ outcome });
  });

  // ---- Dashboard -----------------------------------------------------------
  app.get('/api/bots/:botId/dashboard', (req, res) => {
    const bot = getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const subscriberCount = (
      db.prepare(`SELECT COUNT(*) as n FROM subscribers WHERE bot_id = ?`).get(bot.id) as { n: number }
    ).n;

    const runsByStatus = db
      .prepare(`SELECT status, COUNT(*) as n FROM flow_runs WHERE bot_id = ? GROUP BY status`)
      .all(bot.id) as Array<{ status: string; n: number }>;

    const recentRuns = db
      .prepare(
        `SELECT flow_runs.id, triggers.keyword, flow_runs.status, flow_runs.failure_reason, flow_runs.started_at
         FROM flow_runs JOIN triggers ON flow_runs.trigger_id = triggers.id
         WHERE flow_runs.bot_id = ?
         ORDER BY flow_runs.started_at DESC, flow_runs.rowid DESC
         LIMIT 10`
      )
      .all(bot.id);

    res.json({ subscriberCount, runsByStatus, recentRuns });
  });

  // ---- Module 2: CRM and audience database -------------------------------

  // List + filter — the "table/Kanban of leads" and "filters by segment"
  // from the ТЗ both read from this one endpoint; a segment is just this
  // query with a tag filter applied, not a stored entity.
  app.get('/api/bots/:botId/subscribers', (req, res) => {
    const bot = getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const { tag, leadStatus } = req.query as { tag?: string; leadStatus?: string };
    const conditions = ['bot_id = ?'];
    const params: unknown[] = [bot.id];

    if (tag) {
      conditions.push(
        `id IN (SELECT subscriber_id FROM subscriber_tags JOIN tags ON subscriber_tags.tag_id = tags.id WHERE tags.name = ?)`
      );
      params.push(tag);
    }
    if (leadStatus) {
      conditions.push('lead_status = ?');
      params.push(leadStatus);
    }

    const subscribers = db
      .prepare(`SELECT * FROM subscribers WHERE ${conditions.join(' AND ')} ORDER BY last_interacted_at DESC, rowid DESC`)
      .all(...params) as Subscriber[];

    const tagsBySubscriber = tagsForSubscribers(db, subscribers.map((s) => s.id));
    res.json({ subscribers: subscribers.map((s) => ({ ...s, tags: tagsBySubscriber[s.id] ?? [] })) });
  });

  app.get('/api/subscribers/:id', (req, res) => {
    const subscriber = getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const tags = tagsForSubscribers(db, [subscriber.id])[subscriber.id] ?? [];
    res.json({ subscriber: { ...subscriber, tags } });
  });

  app.patch('/api/subscribers/:id/lead-status', (req, res) => {
    const subscriber = getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const { leadStatus } = req.body ?? {};
    if (!['new', 'in_progress', 'client'].includes(leadStatus)) {
      return res.status(400).json({ error: 'leadStatus must be one of: new, in_progress, client' });
    }

    db.prepare(`UPDATE subscribers SET lead_status = ? WHERE id = ?`).run(leadStatus, subscriber.id);
    res.json({ subscriber: { ...subscriber, lead_status: leadStatus } });
  });

  // The contact profile timeline — every inbound message (matched or not)
  // plus every outbound send, in order. This is what flowEngine's
  // logMessage calls (added for Module 2) exist to make possible.
  app.get('/api/subscribers/:id/messages', (req, res) => {
    const subscriber = getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const messages = db
      // rowid tiebreaker: two messages logged within the same millisecond
      // (created_at has only ms precision) would otherwise sort in an
      // unstable order relative to each other.
      .prepare(`SELECT direction, content, created_at FROM messages WHERE subscriber_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(subscriber.id);

    res.json({ messages });
  });

  app.get('/api/subscribers/:id/notes', (req, res) => {
    const subscriber = getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const notes = db
      .prepare(`SELECT id, body, created_at FROM notes WHERE subscriber_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(subscriber.id);
    res.json({ notes });
  });

  app.post('/api/subscribers/:id/notes', (req, res) => {
    const subscriber = getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const { body } = req.body ?? {};
    if (!body || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'body is required' });
    }

    const id = randomUUID();
    db.prepare(`INSERT INTO notes (id, subscriber_id, tenant_id, body) VALUES (?, ?, ?, ?)`).run(
      id,
      subscriber.id,
      subscriber.tenant_id,
      body
    );
    res.status(201).json({ note: { id, subscriber_id: subscriber.id, body } });
  });

  app.get('/api/bots/:botId/tags', (req, res) => {
    const bot = getBotForTenant(db, req.params.botId, res.locals.tenantId as string);
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    const tags = db.prepare(`SELECT id, name FROM tags WHERE tenant_id = ? ORDER BY name`).all(res.locals.tenantId);
    res.json({ tags });
  });

  // "Быстрое добавление тега прямо из чата" — one call, creates the tag
  // if it doesn't exist yet rather than requiring a separate create-tag
  // step first.
  app.post('/api/subscribers/:id/tags', (req, res) => {
    const subscriber = getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });

    let tag = db.prepare(`SELECT id, name FROM tags WHERE tenant_id = ? AND name = ?`).get(subscriber.tenant_id, name) as
      | { id: string; name: string }
      | undefined;

    if (!tag) {
      const id = randomUUID();
      db.prepare(`INSERT INTO tags (id, tenant_id, name) VALUES (?, ?, ?)`).run(id, subscriber.tenant_id, name);
      tag = { id, name };
    }

    // SQLite-specific; becomes ON CONFLICT DO NOTHING on Postgres.
    db.prepare(`INSERT OR IGNORE INTO subscriber_tags (subscriber_id, tag_id) VALUES (?, ?)`).run(subscriber.id, tag.id);
    res.status(201).json({ tag });
  });

  app.delete('/api/subscribers/:id/tags/:tagId', (req, res) => {
    const subscriber = getSubscriberForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!subscriber) return res.status(404).json({ error: 'subscriber not found' });

    db.prepare(`DELETE FROM subscriber_tags WHERE subscriber_id = ? AND tag_id = ?`).run(subscriber.id, req.params.tagId);
    res.status(204).send();
  });

  // ---- Module 3: Reel analysis and script adaptation (mocked) ------------
  // "Вставьте ссылку" -> analyzeReelMock stands in for yt-dlp + Whisper +
  // an LLM call. Only this function's internals change when the real
  // pipeline replaces it; the request/response shape here is what the
  // real version will also expose.
  app.post('/api/reel-analyses', (req, res) => {
    const sourceUrl = typeof req.body?.sourceUrl === 'string' ? req.body.sourceUrl.trim() : '';
    if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl is required' });

    const fields = analyzeReelMock(sourceUrl);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO reel_analyses (id, tenant_id, source_url, hook, duration_seconds, on_screen_text, structure)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, res.locals.tenantId, fields.source_url, fields.hook, fields.duration_seconds, fields.on_screen_text, fields.structure);

    const analysis = getAnalysisForTenant(db, id, res.locals.tenantId as string)!;
    res.status(201).json({ analysis: { ...analysis, structure: JSON.parse(analysis.structure) } });
  });

  // The "library" from the ТЗ.
  app.get('/api/reel-analyses', (req, res) => {
    const analyses = db
      .prepare(`SELECT * FROM reel_analyses WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(res.locals.tenantId) as ReelAnalysis[];

    res.json({ analyses: analyses.map((a) => ({ ...a, structure: JSON.parse(a.structure) })) });
  });

  app.get('/api/reel-analyses/:id', (req, res) => {
    const analysis = getAnalysisForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });

    res.json({ analysis: { ...analysis, structure: JSON.parse(analysis.structure) } });
  });

  app.post('/api/reel-analyses/:id/scripts', (req, res) => {
    const analysis = getAnalysisForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });

    const niche = typeof req.body?.niche === 'string' ? req.body.niche.trim() : '';
    if (!niche) return res.status(400).json({ error: 'niche is required' });

    const scriptText = generateScriptMock(analysis, niche);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO generated_scripts (id, tenant_id, analysis_id, niche, script_text) VALUES (?, ?, ?, ?, ?)`
    ).run(id, res.locals.tenantId, analysis.id, niche, scriptText);

    res.status(201).json({ script: { id, tenant_id: res.locals.tenantId, analysis_id: analysis.id, niche, script_text: scriptText } });
  });

  app.get('/api/reel-analyses/:id/scripts', (req, res) => {
    const analysis = getAnalysisForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });

    const scripts = db
      .prepare(`SELECT * FROM generated_scripts WHERE analysis_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(analysis.id) as GeneratedScript[];
    res.json({ scripts });
  });

  // "Поиск по тегам ниши" (ТЗ) across the whole library, not just one analysis.
  app.get('/api/scripts', (req, res) => {
    const niche = typeof req.query.niche === 'string' ? req.query.niche : undefined;
    const scripts = (
      niche
        ? db
            .prepare(`SELECT * FROM generated_scripts WHERE tenant_id = ? AND niche = ? ORDER BY created_at DESC, rowid DESC`)
            .all(res.locals.tenantId, niche)
        : db.prepare(`SELECT * FROM generated_scripts WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC`).all(res.locals.tenantId)
    ) as GeneratedScript[];

    res.json({ scripts });
  });

  // ---- Module 4: Carousel generation (mocked LLM text) --------------------

  app.post('/api/brand-presets', (req, res) => {
    const { name, fontFamily, primaryColor, secondaryColor, logoUrl } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const id = randomUUID();
    const fields = {
      font_family: fontFamily ?? 'system-ui',
      primary_color: primaryColor ?? '#111111',
      secondary_color: secondaryColor ?? '#ffffff',
      logo_url: logoUrl ?? null,
    };
    db.prepare(
      `INSERT INTO brand_presets (id, tenant_id, name, font_family, primary_color, secondary_color, logo_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, res.locals.tenantId, name, fields.font_family, fields.primary_color, fields.secondary_color, fields.logo_url);

    res.status(201).json({ preset: { id, tenant_id: res.locals.tenantId, name, ...fields } });
  });

  app.get('/api/brand-presets', (req, res) => {
    const presets = db.prepare(`SELECT * FROM brand_presets WHERE tenant_id = ? ORDER BY name`).all(res.locals.tenantId);
    res.json({ presets });
  });

  // "Промпт → готовая карусель" — generateCarouselMock stands in for the
  // LLM call; everything else (slide storage, editing, listing) is real.
  app.post('/api/carousels', (req, res) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const presetId = req.body?.presetId ?? null;
    if (presetId) {
      const preset = db.prepare(`SELECT id FROM brand_presets WHERE id = ? AND tenant_id = ?`).get(presetId, res.locals.tenantId);
      if (!preset) return res.status(404).json({ error: 'preset not found' });
    }

    const carouselId = randomUUID();
    db.prepare(`INSERT INTO carousels (id, tenant_id, prompt, preset_id) VALUES (?, ?, ?, ?)`).run(
      carouselId,
      res.locals.tenantId,
      prompt,
      presetId
    );

    const insertSlide = db.prepare(
      `INSERT INTO carousel_slides (id, carousel_id, tenant_id, position, headline, body) VALUES (?, ?, ?, ?, ?, ?)`
    );
    generateCarouselMock(prompt).forEach((slide, i) => {
      insertSlide.run(randomUUID(), carouselId, res.locals.tenantId, i, slide.headline, slide.body);
    });

    const carousel = getCarouselForTenant(db, carouselId, res.locals.tenantId as string)!;
    res.status(201).json({ carousel, slides: getSlidesForCarousel(db, carouselId) });
  });

  app.get('/api/carousels', (req, res) => {
    const carousels = db
      .prepare(`SELECT * FROM carousels WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(res.locals.tenantId);
    res.json({ carousels });
  });

  app.get('/api/carousels/:id', (req, res) => {
    const carousel = getCarouselForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!carousel) return res.status(404).json({ error: 'carousel not found' });

    res.json({ carousel, slides: getSlidesForCarousel(db, carousel.id) });
  });

  // Persists manual edits made in the Fabric.js editor (ТЗ: "ручное
  // редактирование слайдов после генерации"). Only text content is
  // persisted, not exact dragged element positions — a documented MVP
  // simplification, not an oversight.
  app.patch('/api/carousels/:carouselId/slides/:slideId', (req, res) => {
    const carousel = getCarouselForTenant(db, req.params.carouselId, res.locals.tenantId as string);
    if (!carousel) return res.status(404).json({ error: 'carousel not found' });

    const slide = db
      .prepare(`SELECT * FROM carousel_slides WHERE id = ? AND carousel_id = ?`)
      .get(req.params.slideId, carousel.id) as CarouselSlide | undefined;
    if (!slide) return res.status(404).json({ error: 'slide not found' });

    const headline = typeof req.body?.headline === 'string' ? req.body.headline : slide.headline;
    const body = typeof req.body?.body === 'string' ? req.body.body : slide.body;

    db.prepare(`UPDATE carousel_slides SET headline = ?, body = ? WHERE id = ?`).run(headline, body, slide.id);
    res.json({ slide: { ...slide, headline, body } });
  });

  // ---- Module 5: Cross-platform autoposting (mocked) ---------------------

  const PLATFORMS = ['instagram', 'tiktok', 'youtube_shorts'];

  app.post('/api/scheduled-posts', (req, res) => {
    const { platform, caption, scheduledAt, requiresApproval } = req.body ?? {};
    if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: `platform must be one of: ${PLATFORMS.join(', ')}` });
    if (!caption || typeof caption !== 'string') return res.status(400).json({ error: 'caption is required' });
    if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) return res.status(400).json({ error: 'scheduledAt must be a valid date' });

    const id = randomUUID();
    const status = requiresApproval ? 'pending_approval' : 'scheduled';
    db.prepare(
      `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, requires_approval, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, res.locals.tenantId, platform, caption, new Date(scheduledAt).toISOString(), requiresApproval ? 1 : 0, status);

    if (status === 'pending_approval') {
      notify(db, res.locals.tenantId as string, 'post_pending_approval', `Пост в ${platform} ждёт согласования`, id);
    }

    res.status(201).json({ post: getScheduledPostForTenant(db, id, res.locals.tenantId as string) });
  });

  // The calendar/queue screen from the ТЗ reads from here, filtered by
  // status and/or date range.
  app.get('/api/scheduled-posts', (req, res) => {
    const { status, from, to } = req.query as { status?: string; from?: string; to?: string };
    const conditions = ['tenant_id = ?'];
    const params: unknown[] = [res.locals.tenantId];

    if (status) {
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

    const posts = db
      .prepare(`SELECT * FROM scheduled_posts WHERE ${conditions.join(' AND ')} ORDER BY scheduled_at ASC, rowid ASC`)
      .all(...params) as Record<string, unknown>[];

    res.json({ posts: posts.map(withBooleanRequiresApproval) });
  });

  app.get('/api/scheduled-posts/:id', (req, res) => {
    const post = getScheduledPostForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!post) return res.status(404).json({ error: 'post not found' });
    res.json({ post });
  });

  // Approval workflow is optional per the ТЗ — only posts created with
  // requiresApproval land in pending_approval in the first place.
  app.post('/api/scheduled-posts/:id/approve', (req, res) => {
    const post = getScheduledPostForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!post) return res.status(404).json({ error: 'post not found' });
    if (post.status !== 'pending_approval') return res.status(422).json({ error: 'post is not pending approval' });

    db.prepare(`UPDATE scheduled_posts SET status = 'scheduled' WHERE id = ?`).run(post.id);
    res.json({ post: getScheduledPostForTenant(db, post.id, res.locals.tenantId as string) });
  });

  app.post('/api/scheduled-posts/:id/reject', (req, res) => {
    const post = getScheduledPostForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!post) return res.status(404).json({ error: 'post not found' });
    if (post.status !== 'pending_approval') return res.status(422).json({ error: 'post is not pending approval' });

    db.prepare(`UPDATE scheduled_posts SET status = 'rejected' WHERE id = ?`).run(post.id);
    res.json({ post: getScheduledPostForTenant(db, post.id, res.locals.tenantId as string) });
  });

  // Manual trigger for the polling publisher — there's no real queue to
  // fire an event, so this is what lets a demo/test see a due post
  // actually "publish" without waiting for the timer in server.ts.
  app.post('/api/scheduled-posts/process-due', (_req, res) => {
    res.json(publishDuePosts(db));
  });

  // ---- Module 6: Content plan from CRM + Module 3 (the real differentiator) --
  // No new tables — computeContentRecommendations reads Module 2's tags/
  // subscribers and Module 3's generated_scripts directly.
  app.get('/api/content-recommendations', (req, res) => {
    const all = computeContentRecommendations(db, res.locals.tenantId as string);
    const segment = typeof req.query.segment === 'string' ? req.query.segment : undefined;
    const recommendations = segment ? all.filter((r) => r.segment.toLowerCase() === segment.toLowerCase()) : all;
    res.json({ recommendations });
  });

  // ---- Module 8: Video editing, Levels 1-2 (mocked Shotstack/Creatomate) --

  const VIDEO_TEMPLATES: VideoTemplate[] = ['auto_crop_916', 'template_with_transitions'];

  app.post('/api/video-edit-jobs', (req, res) => {
    const sourceVideoUrl = typeof req.body?.sourceVideoUrl === 'string' ? req.body.sourceVideoUrl.trim() : '';
    const template = req.body?.template;
    if (!sourceVideoUrl) return res.status(400).json({ error: 'sourceVideoUrl is required' });
    if (!VIDEO_TEMPLATES.includes(template)) return res.status(400).json({ error: `template must be one of: ${VIDEO_TEMPLATES.join(', ')}` });

    const id = randomUUID();
    db.prepare(`INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template) VALUES (?, ?, ?, ?)`).run(
      id,
      res.locals.tenantId,
      sourceVideoUrl,
      template
    );

    res.status(201).json({ job: getVideoJobForTenant(db, id, res.locals.tenantId as string) });
  });

  app.get('/api/video-edit-jobs', (req, res) => {
    const jobs = db
      .prepare(`SELECT * FROM video_edit_jobs WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(res.locals.tenantId);
    res.json({ jobs });
  });

  // The frontend polls this while a job is `processing` to drive the
  // progress bar the ТЗ calls for.
  app.get('/api/video-edit-jobs/:id', (req, res) => {
    const job = getVideoJobForTenant(db, req.params.id, res.locals.tenantId as string);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ job });
  });

  // Manual trigger for the polling renderer — same reasoning as
  // /api/scheduled-posts/process-due in Module 5: no real queue to fire
  // an event, so this lets a demo see progress advance without waiting
  // for the timer in server.ts.
  app.post('/api/video-edit-jobs/process-tick', (_req, res) => {
    res.json(advanceRenderJobs(db));
  });

  // ---- Push notifications (shared by Modules 5 and 8) ---------------------

  // The value itself isn't tenant-specific (one VAPID keypair for the
  // whole server), but the route still sits behind requireApiKey like
  // every other /api/* route — fine, since by the time a browser needs
  // this it already has an API key from "Быстрый старт" anyway.
  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({ publicKey: getOrCreateVapidKeys().publicKey });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const { endpoint, keys } = req.body ?? {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'endpoint and keys.{p256dh,auth} are required' });

    // Re-subscribing with the same endpoint (e.g. browser reloaded the
    // page) replaces the old row instead of erroring or duplicating.
    db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
    db.prepare(`INSERT INTO push_subscriptions (id, tenant_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)`).run(
      randomUUID(),
      res.locals.tenantId,
      endpoint,
      keys.p256dh,
      keys.auth
    );

    res.status(201).json({ status: 'subscribed' });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const { endpoint } = req.body ?? {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

    db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND tenant_id = ?`).run(endpoint, res.locals.tenantId);
    res.json({ status: 'unsubscribed' });
  });

  // The in-app fallback the ТЗ requires when push isn't permitted in the
  // browser — polled by the frontend regardless of push permission state.
  app.get('/api/notifications', (req, res) => {
    const unreadOnly = req.query.unreadOnly === 'true';
    res.json({ notifications: listNotifications(db, res.locals.tenantId as string, unreadOnly) });
  });

  app.post('/api/notifications/:id/read', (req, res) => {
    db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ? AND tenant_id = ?`).run(req.params.id, res.locals.tenantId);
    res.json({ status: 'ok' });
  });

  app.post('/api/notifications/read-all', (_req, res) => {
    db.prepare(`UPDATE notifications SET is_read = 1 WHERE tenant_id = ? AND is_read = 0`).run(res.locals.tenantId);
    res.json({ status: 'ok' });
  });

  // ---- Mock Instagram webhook --------------------------------------------
  // Simulates Meta calling us — NOT protected by tenant API key (Meta
  // doesn't have one). The real POST /webhooks/instagram will carry this
  // same event_id-dedup contract, plus X-Hub-Signature-256 verification
  // that this mock intentionally does not implement yet.
  app.post('/webhooks/mock/instagram', (req, res) => {
    const { eventId, externalAccountId, externalUserId, messageText } = req.body ?? {};
    if (!eventId || !externalAccountId || !externalUserId || !messageText) {
      return res.status(400).json({ error: 'eventId, externalAccountId, externalUserId and messageText are required' });
    }

    const bot = db.prepare(`SELECT * FROM bots WHERE external_account_id = ?`).get(externalAccountId) as
      | Bot
      | undefined;
    if (!bot) return res.status(404).json({ error: 'unknown externalAccountId' });

    const claimed = tryClaimWebhookEvent(db, eventId, bot.id, req.body);
    if (!claimed) return res.json({ status: 'already_processed' });

    const outcome = runFlow(db, {
      tenantId: bot.tenant_id,
      botId: bot.id,
      externalUserId,
      messageText,
      isTest: false,
    });

    db.prepare(`UPDATE webhook_events SET processed_at = ? WHERE event_id = ?`).run(new Date().toISOString(), eventId);

    res.json({ outcome });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

function requireApiKey(db: Database.Database) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'missing_api_key' });

    const tenantId = resolveTenantIdFromApiKey(db, header.slice('Bearer '.length));
    if (!tenantId) return res.status(401).json({ error: 'invalid_api_key' });

    res.locals.tenantId = tenantId;
    next();
  };
}

// Scoping every lookup to (id, tenant_id) together — rather than fetching
// by id and checking tenant_id after — means "belongs to another tenant"
// and "doesn't exist" are indistinguishable from the response (both 404).
function getBotForTenant(db: Database.Database, botId: string, tenantId: string): Bot | undefined {
  return db.prepare(`SELECT * FROM bots WHERE id = ? AND tenant_id = ?`).get(botId, tenantId) as Bot | undefined;
}

function getSubscriberForTenant(db: Database.Database, subscriberId: string, tenantId: string): Subscriber | undefined {
  return db.prepare(`SELECT * FROM subscribers WHERE id = ? AND tenant_id = ?`).get(subscriberId, tenantId) as
    | Subscriber
    | undefined;
}

interface SubscriberTagRef {
  id: string;
  name: string;
}

// Returns {id, name} pairs, not just names — the UI needs the id to call
// DELETE /api/subscribers/:id/tags/:tagId; a bare name isn't enough to
// remove a tag.
function tagsForSubscribers(db: Database.Database, subscriberIds: string[]): Record<string, SubscriberTagRef[]> {
  if (subscriberIds.length === 0) return {};
  const placeholders = subscriberIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT subscriber_tags.subscriber_id as subscriberId, tags.id as id, tags.name as name
       FROM subscriber_tags JOIN tags ON subscriber_tags.tag_id = tags.id
       WHERE subscriber_tags.subscriber_id IN (${placeholders})`
    )
    .all(...subscriberIds) as Array<{ subscriberId: string; id: string; name: string }>;

  const result: Record<string, SubscriberTagRef[]> = {};
  for (const row of rows) {
    (result[row.subscriberId] ??= []).push({ id: row.id, name: row.name });
  }
  return result;
}

function getAnalysisForTenant(db: Database.Database, id: string, tenantId: string): ReelAnalysis | undefined {
  return db.prepare(`SELECT * FROM reel_analyses WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as
    | ReelAnalysis
    | undefined;
}

function getCarouselForTenant(db: Database.Database, id: string, tenantId: string): Carousel | undefined {
  return db.prepare(`SELECT * FROM carousels WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as Carousel | undefined;
}

function getSlidesForCarousel(db: Database.Database, carouselId: string): CarouselSlide[] {
  return db.prepare(`SELECT * FROM carousel_slides WHERE carousel_id = ? ORDER BY position ASC`).all(carouselId) as CarouselSlide[];
}

// SQLite has no boolean type — requires_approval is stored as 0/1.
// Converting it here means every caller sees the real boolean the
// ScheduledPost type promises, not a lying "0 | 1" that happens to work
// in JS truthiness checks.
function withBooleanRequiresApproval(row: Record<string, unknown>): ScheduledPost {
  return { ...row, requires_approval: row.requires_approval === 1 } as ScheduledPost;
}

function getScheduledPostForTenant(db: Database.Database, id: string, tenantId: string): ScheduledPost | undefined {
  const row = db.prepare(`SELECT * FROM scheduled_posts WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as
    | Record<string, unknown>
    | undefined;
  return row ? withBooleanRequiresApproval(row) : undefined;
}

function getVideoJobForTenant(db: Database.Database, id: string, tenantId: string): VideoEditJob | undefined {
  return db.prepare(`SELECT * FROM video_edit_jobs WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as VideoEditJob | undefined;
}

// Returns false if this event_id was already claimed by a prior (or
// concurrent) delivery — the INSERT's PRIMARY KEY(event_id) is the actual
// guarantee, not a prior SELECT, so a race between two deliveries of the
// same webhook can't double-process it.
function tryClaimWebhookEvent(db: Database.Database, eventId: string, botId: string, payload: unknown): boolean {
  try {
    db.prepare(`INSERT INTO webhook_events (event_id, bot_id, payload) VALUES (?, ?, ?)`).run(
      eventId,
      botId,
      JSON.stringify(payload)
    );
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) return false;
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
