-- Sonar / Module 1 (bot constructor) — SQLite schema.
-- Written to migrate ~1:1 to PostgreSQL later: TEXT ids are UUID strings
-- (-> uuid), TEXT json columns (-> jsonb), INTEGER 0/1 flags (-> boolean).

-- One row per paying client (blogger/expert/agency). Root of multi-tenancy:
-- every other table hangs off tenant_id, directly or via bot_id, so a
-- client's data can never surface in another client's queries.
CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- API keys authenticate which tenant an API request is acting as. Only the
-- hash is stored (SHA-256 over a high-entropy random token — not a
-- password, so no need for a slow KDF like bcrypt); the raw key is shown to
-- the caller exactly once, at creation time, and never persisted.
CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  key_hash   TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

-- One bot = one social account. MVP assumes 1 bot : 1 external account
-- (no shared/team accounts yet) — external_account_id is where the mock
-- webhook's account id lands, and later the real Instagram Business Account id.
CREATE TABLE bots (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  name               TEXT NOT NULL,
  platform           TEXT NOT NULL DEFAULT 'instagram',
  external_account_id TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bots_tenant ON bots(tenant_id);

-- Versioned flow definitions. Publishing a new version inserts a new row
-- rather than overwriting — that's what makes the future rollback endpoint
-- a plain SELECT instead of needing separate history tracking.
CREATE TABLE flows (
  id         TEXT NOT NULL,
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  version    INTEGER NOT NULL,
  definition TEXT NOT NULL, -- JSON: FlowDefinition (src/types.ts)
  status     TEXT NOT NULL DEFAULT 'draft', -- draft | published
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (id, version)
);

CREATE INDEX idx_flows_bot ON flows(bot_id);

-- Keyword -> flow bindings. A trigger always points at one specific flow
-- version, not "the latest" — so a flow can be republished without silently
-- changing what an already-live trigger runs.
CREATE TABLE triggers (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id),
  flow_id     TEXT NOT NULL,
  flow_version INTEGER NOT NULL,
  keyword     TEXT NOT NULL,
  match_type  TEXT NOT NULL DEFAULT 'contains', -- contains | exact
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (flow_id, flow_version) REFERENCES flows(id, version)
);

CREATE INDEX idx_triggers_bot ON triggers(bot_id);

-- One row per person who has ever messaged a bot. last_interacted_at is
-- what the 24h Instagram messaging window is computed from.
CREATE TABLE subscribers (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  bot_id             TEXT NOT NULL REFERENCES bots(id),
  external_user_id   TEXT NOT NULL,
  first_seen_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_interacted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- CRM lead status (Module 2). Lives on subscribers rather than a
  -- separate table because it's 1:1 and single-valued — there's exactly
  -- one current status per subscriber, not a history of them.
  lead_status        TEXT NOT NULL DEFAULT 'new', -- new | in_progress | client
  UNIQUE (bot_id, external_user_id)
);

-- Inbound webhook deliveries, keyed by Meta's event_id. This is dedup layer
-- #1 (CLAUDE.md): a retried delivery of the same event_id is a no-op.
CREATE TABLE webhook_events (
  event_id     TEXT PRIMARY KEY,
  bot_id       TEXT NOT NULL REFERENCES bots(id),
  payload      TEXT NOT NULL, -- JSON, raw event as received
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT
);

-- Real (non-test-mode) flow executions. run_date + the unique index below
-- is dedup layer #2 (CLAUDE.md): one subscriber can't trigger the same
-- trigger twice on the same day. Enforced as a DB constraint, not just an
-- application check, because webhook deliveries can race each other.
-- Test-mode runs never write here (see CLAUDE.md: test mode must not
-- pollute conversion analytics), so there's no is_test flag to filter on.
CREATE TABLE flow_runs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  bot_id          TEXT NOT NULL REFERENCES bots(id),
  trigger_id      TEXT NOT NULL REFERENCES triggers(id),
  subscriber_id   TEXT NOT NULL REFERENCES subscribers(id),
  flow_id         TEXT NOT NULL,
  flow_version    INTEGER NOT NULL,
  run_date        TEXT NOT NULL, -- subscriber's local trigger day, YYYY-MM-DD
  status          TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  failure_reason  TEXT, -- e.g. outside_24h_window_no_fallback_configured
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at    TEXT,
  UNIQUE (trigger_id, subscriber_id, run_date)
);

CREATE INDEX idx_flow_runs_subscriber ON flow_runs(subscriber_id);

-- Outbound messages sent by the mock Instagram webhook simulator. Same
-- table name and shape CLAUDE.md expects to carry over once the real
-- POST /webhooks/instagram integration replaces the mock.
CREATE TABLE mock_sent_messages (
  id            TEXT PRIMARY KEY,
  flow_run_id   TEXT NOT NULL REFERENCES flow_runs(id),
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  channel       TEXT NOT NULL DEFAULT 'dm', -- dm | comment_fallback
  content       TEXT NOT NULL,
  sent_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_mock_sent_messages_flow_run ON mock_sent_messages(flow_run_id);

-- ---- Module 2: CRM and audience database ---------------------------------

-- Tags are per-tenant, not global — "VIP" for one blogger's audience has
-- nothing to do with "VIP" for another's.
CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, name)
);

CREATE TABLE subscriber_tags (
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  tag_id        TEXT NOT NULL REFERENCES tags(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (subscriber_id, tag_id)
);

-- Segmentation ("everyone tagged X") is just a query over this index, not
-- a materialized segment table — a segment is a saved filter, not stored
-- data of its own, so there's nothing else to model here.
CREATE INDEX idx_subscriber_tags_tag ON subscriber_tags(tag_id);

-- Multiple notes over time, not one field — the ТЗ asks for a contact
-- timeline, and a single "notes" column on subscribers can't represent
-- who wrote what when.
CREATE TABLE notes (
  id            TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_notes_subscriber ON notes(subscriber_id);

-- Full bidirectional conversation log — the real gap Module 2 exposed:
-- until now only outbound bot sends were recorded (mock_sent_messages,
-- scoped to a flow_run), and only for messages that matched a trigger.
-- A CRM contact profile needs every inbound message too, including ones
-- that matched nothing, or the "история переписки" requirement is
-- impossible to satisfy. mock_sent_messages is left as-is (Module 1's
-- per-run execution record); this table is the subscriber-centric
-- timeline the CRM UI reads from — some outbound content is intentionally
-- duplicated between the two, they serve different queries.
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  bot_id        TEXT NOT NULL REFERENCES bots(id),
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  direction     TEXT NOT NULL, -- in | out
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_messages_subscriber ON messages(subscriber_id, created_at);

-- ---- Module 3: Reel analysis and script adaptation (mocked pipeline) -----
-- ТЗ calls for yt-dlp+Whisper (download/transcribe) and an LLM
-- (analyze/generate) plus pgvector for similarity search. None of that
-- runs here — analyzeReelMock/generateScriptMock (src/reelAnalysis.ts)
-- produce deterministic fake output from the same storage/API shape the
-- real pipeline will use, so swapping the mock out later doesn't change
-- this schema. No pgvector means no similarity search yet — out of scope
-- until Postgres migration actually happens.
CREATE TABLE reel_analyses (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  source_url       TEXT NOT NULL,
  hook             TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  on_screen_text   TEXT NOT NULL,
  structure        TEXT NOT NULL, -- JSON: StructureBeat[] (src/types.ts)
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_reel_analyses_tenant ON reel_analyses(tenant_id);

CREATE TABLE generated_scripts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  analysis_id TEXT NOT NULL REFERENCES reel_analyses(id),
  niche       TEXT NOT NULL,
  script_text TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_generated_scripts_analysis ON generated_scripts(analysis_id);
-- "поиск по тегам ниши" (ТЗ) — a plain indexed column, not a tag system;
-- unlike CRM tags, a script has exactly one niche it was generated for.
CREATE INDEX idx_generated_scripts_tenant_niche ON generated_scripts(tenant_id, niche);

-- ---- Module 4: Carousel generation (mocked LLM text, Fabric.js render) ---
-- Slide content is stored as OUR OWN small schema (headline/body/color),
-- not raw Fabric.js canvas JSON — Fabric.js is a rendering choice for the
-- editor, and its serialization format is low-level/library-specific.
-- Keeping the stored shape independent means swapping the renderer later
-- doesn't touch this schema or the API contract.
CREATE TABLE brand_presets (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  font_family     TEXT NOT NULL DEFAULT 'system-ui',
  primary_color   TEXT NOT NULL DEFAULT '#111111',
  secondary_color TEXT NOT NULL DEFAULT '#ffffff',
  logo_url        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_brand_presets_tenant ON brand_presets(tenant_id);

CREATE TABLE carousels (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  prompt     TEXT NOT NULL,
  preset_id  TEXT REFERENCES brand_presets(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_carousels_tenant ON carousels(tenant_id);

CREATE TABLE carousel_slides (
  id          TEXT PRIMARY KEY,
  carousel_id TEXT NOT NULL REFERENCES carousels(id),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  position    INTEGER NOT NULL,
  headline    TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (carousel_id, position)
);

CREATE INDEX idx_carousel_slides_carousel ON carousel_slides(carousel_id, position);

-- ---- Module 5: Cross-platform autoposting (mocked platform APIs) --------
-- ТЗ calls for Celery/BullMQ on Redis; decided to skip that infra for now
-- (no real load yet, same reasoning as staying on SQLite) — src/publisher.ts
-- polls this table on a timer instead of running a real job queue. The
-- mock stands in for Instagram Content Publishing API / TikTok Content
-- Posting API / YouTube Data API — each needs its own real app review we
-- don't have yet.
CREATE TABLE scheduled_posts (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  platform           TEXT NOT NULL, -- instagram | tiktok | youtube_shorts
  caption            TEXT NOT NULL,
  scheduled_at       TEXT NOT NULL,
  requires_approval  INTEGER NOT NULL DEFAULT 0,
  -- pending_approval | scheduled | published | failed | rejected
  status             TEXT NOT NULL DEFAULT 'scheduled',
  failure_reason     TEXT, -- token_expired | rejected_by_platform | rate_limited
  published_at       TEXT,
  external_post_url  TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_scheduled_posts_tenant ON scheduled_posts(tenant_id);
-- What the polling publisher scans on every tick.
CREATE INDEX idx_scheduled_posts_due ON scheduled_posts(status, scheduled_at);

-- ---- Module 8: Video editing, Levels 1-2 only (mocked Shotstack/Creatomate) --
-- Level 3 (custom FFmpeg engine + AI upscaling) is explicitly its own R&D
-- track per the ТЗ and out of scope here. source_video_url is just a
-- reference string, same as Module 3's reel URLs — no real file upload/
-- object storage, we never actually handle video bytes.
CREATE TABLE video_edit_jobs (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  source_video_url  TEXT NOT NULL,
  template          TEXT NOT NULL, -- auto_crop_916 | template_with_transitions
  status            TEXT NOT NULL DEFAULT 'processing', -- processing | completed | failed
  progress_percent  INTEGER NOT NULL DEFAULT 0,
  output_url        TEXT,
  failure_reason    TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at      TEXT
);

CREATE INDEX idx_video_edit_jobs_tenant ON video_edit_jobs(tenant_id);
-- What the polling renderer scans on every tick.
CREATE INDEX idx_video_edit_jobs_processing ON video_edit_jobs(status);

-- ---- Push notifications (shared by Modules 5 and 8, per both ТЗ) --------
-- Deliberately one shared implementation, not duplicated per module — the
-- Module 8 addendum says explicitly not to build this twice.
CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_push_subscriptions_tenant ON push_subscriptions(tenant_id);

-- The ТЗ's required fallback ("если push не разрешён в браузере —
-- дублировать статус in-app уведомлением") is implemented by always
-- writing here first; push delivery (if any subscription exists) is a
-- best-effort add-on, not the only way a client learns about a status
-- change.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  -- post_published | post_failed | post_pending_approval | video_completed | video_failed
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  related_id TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_notifications_tenant ON notifications(tenant_id, created_at);
