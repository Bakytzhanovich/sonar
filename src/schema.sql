-- Sonar / Module 1+ — PostgreSQL schema.
-- Migrated from SQLite (see git history for the original). id columns stay
-- TEXT rather than uuid on purpose: several tests seed non-UUID fixture ids
-- ('t1', 'bot-1', ...), and TEXT behaves identically to uuid for every
-- query pattern actually used here (equality, JOIN, FK) — switching would
-- only add test-fixture churn, not fix anything. JSON columns did move to
-- jsonb and 0/1 flags to real boolean, since neither breaks existing data.

-- One row per paying client (blogger/expert/agency). Root of multi-tenancy:
-- every other table hangs off tenant_id, directly or via bot_id, so a
-- client's data can never surface in another client's queries.
CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys authenticate which tenant an API request is acting as. Only the
-- hash is stored (SHA-256 over a high-entropy random token — not a
-- password, so no need for a slow KDF like bcrypt); the raw key is shown to
-- the caller exactly once, at creation time, and never persisted.
CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  key_hash   TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bots_tenant ON bots(tenant_id);

-- Versioned flow definitions. Publishing a new version inserts a new row
-- rather than overwriting — that's what makes the rollback endpoint
-- (POST /api/triggers/:id/rollback) a plain SELECT instead of needing
-- separate history tracking.
CREATE TABLE flows (
  id         TEXT NOT NULL,
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  version    INTEGER NOT NULL,
  definition JSONB NOT NULL, -- FlowDefinition (src/types.ts)
  status     TEXT NOT NULL DEFAULT 'draft', -- draft | published
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (flow_id, flow_version) REFERENCES flows(id, version)
);

CREATE INDEX idx_triggers_bot ON triggers(bot_id);

-- Two active triggers on the same bot for the same keyword is not a valid
-- state (matchTrigger() would silently pick whichever is older) — this is
-- the source-of-truth backstop for the app-level pre-check in api.ts,
-- same two-layer shape as flow_runs' UNIQUE below. Normalized the same way
-- normalizeKeyword() does (trim + lowercase) so "Цена"/" цена " collide too.
CREATE UNIQUE INDEX idx_triggers_bot_keyword_unique ON triggers (bot_id, lower(trim(keyword))) WHERE is_active = true;

-- One row per person who has ever messaged a bot. last_interacted_at is
-- what the 24h Instagram messaging window is computed from. seq is a
-- Postgres stand-in for SQLite's implicit rowid, kept purely as an
-- insertion-order tiebreaker for listing queries (see idx below).
CREATE TABLE subscribers (
  id                 TEXT PRIMARY KEY,
  seq                BIGSERIAL,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  bot_id             TEXT NOT NULL REFERENCES bots(id),
  external_user_id   TEXT NOT NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_interacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  payload      JSONB NOT NULL, -- raw event as received
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Real (non-test-mode) flow executions. run_date + the unique index below
-- is dedup layer #2 (CLAUDE.md): one subscriber can't trigger the same
-- trigger twice on the same day. Enforced as a DB constraint, not just an
-- application check, because webhook deliveries can race each other.
-- Test-mode runs never write here (see CLAUDE.md: test mode must not
-- pollute conversion analytics), so there's no is_test flag to filter on.
CREATE TABLE flow_runs (
  id              TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  bot_id          TEXT NOT NULL REFERENCES bots(id),
  trigger_id      TEXT NOT NULL REFERENCES triggers(id),
  subscriber_id   TEXT NOT NULL REFERENCES subscribers(id),
  flow_id         TEXT NOT NULL,
  flow_version    INTEGER NOT NULL,
  run_date        TEXT NOT NULL, -- subscriber's local trigger day, YYYY-MM-DD
  status          TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  failure_reason  TEXT, -- e.g. outside_24h_window_no_fallback_configured
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
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
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mock_sent_messages_flow_run ON mock_sent_messages(flow_run_id);

-- ---- Module 2: CRM and audience database ---------------------------------

-- Tags are per-tenant, not global — "VIP" for one blogger's audience has
-- nothing to do with "VIP" for another's.
CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE subscriber_tags (
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  tag_id        TEXT NOT NULL REFERENCES tags(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  seq           BIGSERIAL,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
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
  seq           BIGSERIAL,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  bot_id        TEXT NOT NULL REFERENCES bots(id),
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  direction     TEXT NOT NULL, -- in | out
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_subscriber ON messages(subscriber_id, created_at);

-- ---- Module 3: Reel analysis and script adaptation (mocked pipeline) -----
-- ТЗ calls for yt-dlp+Whisper (download/transcribe) and an LLM
-- (analyze/generate) plus pgvector for similarity search. None of that
-- runs here — analyzeReelMock/generateScriptMock (src/reelAnalysis.ts)
-- produce deterministic fake output from the same storage/API shape the
-- real pipeline will use, so swapping the mock out later doesn't change
-- this schema. pgvector itself is still deferred — no similarity search
-- yet, even though we're on Postgres now; a real embeddings pipeline is
-- its own follow-up, not a side effect of this migration.
CREATE TABLE reel_analyses (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  source_url       TEXT NOT NULL,
  hook             TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  on_screen_text   TEXT NOT NULL,
  structure        JSONB NOT NULL, -- StructureBeat[] (src/types.ts)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reel_analyses_tenant ON reel_analyses(tenant_id);

CREATE TABLE generated_scripts (
  id          TEXT PRIMARY KEY,
  seq         BIGSERIAL,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  analysis_id TEXT NOT NULL REFERENCES reel_analyses(id),
  niche       TEXT NOT NULL,
  script_text TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_brand_presets_tenant ON brand_presets(tenant_id);

CREATE TABLE carousels (
  id         TEXT PRIMARY KEY,
  seq        BIGSERIAL,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  prompt     TEXT NOT NULL,
  preset_id  TEXT REFERENCES brand_presets(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_carousels_tenant ON carousels(tenant_id);

CREATE TABLE carousel_slides (
  id          TEXT PRIMARY KEY,
  carousel_id TEXT NOT NULL REFERENCES carousels(id),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  position    INTEGER NOT NULL,
  headline    TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (carousel_id, position)
);

CREATE INDEX idx_carousel_slides_carousel ON carousel_slides(carousel_id, position);

-- ---- Module 5: Cross-platform autoposting (mocked platform APIs) --------
-- ТЗ calls for Celery/BullMQ on Redis; decided to skip that infra for now
-- (no real load yet) — src/publisher.ts polls this table on a timer
-- instead of running a real job queue. The mock stands in for Instagram
-- Content Publishing API / TikTok Content Posting API / YouTube Data API —
-- each needs its own real app review we don't have yet.
CREATE TABLE scheduled_posts (
  id                 TEXT PRIMARY KEY,
  seq                BIGSERIAL,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  platform           TEXT NOT NULL, -- instagram | tiktok | youtube_shorts
  caption            TEXT NOT NULL,
  scheduled_at       TIMESTAMPTZ NOT NULL,
  requires_approval  BOOLEAN NOT NULL DEFAULT false,
  -- pending_approval | scheduled | publishing | published | failed | rejected
  -- 'publishing' is a transient claim state set by publishDuePosts; claimed_at
  -- lets a stale claim (the process crashed or threw mid-processing) be
  -- reclaimed and retried instead of stuck there forever.
  status             TEXT NOT NULL DEFAULT 'scheduled',
  claimed_at         TIMESTAMPTZ,
  failure_reason     TEXT, -- token_expired | rejected_by_platform | rate_limited
  published_at       TIMESTAMPTZ,
  external_post_url  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
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
  seq               BIGSERIAL,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  source_video_url  TEXT NOT NULL,
  template          TEXT NOT NULL, -- auto_crop_916 | template_with_transitions | ai_smart_cut
  status            TEXT NOT NULL DEFAULT 'processing', -- processing | completed | failed
  progress_percent  INTEGER NOT NULL DEFAULT 0,
  output_url        TEXT,
  -- Cover frame for the finished render, so a completed job is recognisable
  -- in the queue without pressing play. Nullable: posters are best-effort.
  poster_url        TEXT,
  failure_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  -- ---- Level 3 (own FFmpeg engine) fields ---------------------------------
  -- 'preset' jobs are the mocked Shotstack/Creatomate path above and ignore
  -- everything below. 'smart_cut' jobs are processed by videoPipeline.ts in a
  -- separate worker process, because ffmpeg is CPU-bound for minutes at a
  -- time and would starve the API's event loop.
  pipeline          TEXT NOT NULL DEFAULT 'preset', -- preset | smart_cut
  -- Object-storage keys, not URLs: the bucket is ours, and a stored presigned
  -- URL would expire while the row outlives it. Rendered into a URL on read.
  source_object_key TEXT,
  output_object_key TEXT,
  -- Which stage the job is in, and the accumulated per-stage results
  -- (probe output, transcript, cut plan). Checkpointing these is what makes a
  -- retry resume at the failed stage instead of paying for transcription
  -- again.
  stage             TEXT, -- probe | transcribe | plan_cuts | render | upload
  artifacts         JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  -- Burn dynamic captions into the render. On by default: it is what the
  -- Level-3 output is for. Stored per job because burning is irreversible —
  -- a client who wants a clean master must be able to ask for one.
  subtitles         BOOLEAN NOT NULL DEFAULT true,
  -- Neural background-noise removal (ffmpeg arnndn / RNNoise). Off by
  -- default: it is the right call for a street recording and the wrong one
  -- for anything with deliberate ambience or music.
  -- 'auto' measures the recording and decides; 'on'/'off' are the user
  -- overriding that. Auto is the default because asking someone to judge
  -- their own noise floor before they have seen the result is asking the
  -- wrong person.
  denoise_mode      TEXT NOT NULL DEFAULT 'auto',
  -- Stop after captions are generated and wait for the user to correct them.
  -- Captions are burned into the pixels, so a wrong word is permanent; on
  -- languages the speech models only approximate, reviewing first is the
  -- difference between a usable feature and a gamble.
  -- 'auto' pauses only when the transcript's language is one the speech
  -- models get wrong often enough to matter. Russian and English go straight
  -- through; Kazakh stops for a human.
  review_mode       TEXT NOT NULL DEFAULT 'auto',
  -- Which caption look to burn in (see subtitlePresets.ts). Stored per job,
  -- not per tenant: a blogger's serious piece and their joke reel do not
  -- want the same typography.
  subtitle_preset   TEXT NOT NULL DEFAULT 'classic',
  -- Where in the frame those captions sit (see subtitlePositions.ts). A
  -- separate axis from the look, because the same typography belongs over the
  -- face on one clip and under it on the next. 'auto' means "wherever the
  -- preset puts it", which is what keeps the older 'Снизу' preset honest.
  subtitle_position TEXT NOT NULL DEFAULT 'auto',
  -- Typed by hand, drawn in a band above the picture (headline.ts). NULL
  -- means no band at all, and the video keeps the whole frame.
  headline          TEXT,
  -- How that headline is set: typeface, size step and colour, each an id from
  -- headlineStyles.ts rather than a raw font name or hex. A closed list is
  -- what keeps a render from asking libass for a family it will quietly
  -- replace, and a colour from landing unreadable on the black band.
  headline_font     TEXT NOT NULL DEFAULT 'montserrat',
  headline_size     TEXT NOT NULL DEFAULT 'medium',
  headline_color    TEXT NOT NULL DEFAULT 'white',
  -- Remove audible breaths and mouth noise (breathDetector.ts). Off by
  -- default: it is the most destructive pass in the pipeline, and on a
  -- recording with a high noise floor it finds nothing anyway.
  remove_breaths    BOOLEAN NOT NULL DEFAULT false,
  -- Worker lease. Unlike the preset path, a smart_cut job legitimately sits
  -- in 'processing' for minutes, so a timestamped claim is the only way to
  -- tell "another worker is on it" from "a worker died holding it".
  claimed_at        TIMESTAMPTZ
);

CREATE INDEX idx_video_edit_jobs_tenant ON video_edit_jobs(tenant_id);
-- What the polling renderer scans on every tick.
CREATE INDEX idx_video_edit_jobs_processing ON video_edit_jobs(status);
-- What the Level-3 worker claims from: unfinished jobs of its own pipeline.
CREATE INDEX idx_video_edit_jobs_pipeline ON video_edit_jobs(pipeline, status, claimed_at);

-- ---- Push notifications (shared by Modules 5 and 8, per both ТЗ) --------
-- Deliberately one shared implementation, not duplicated per module — the
-- Module 8 addendum says explicitly not to build this twice.
CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_subscriptions_tenant ON push_subscriptions(tenant_id);

-- The ТЗ's required fallback ("если push не разрешён в браузере —
-- дублировать статус in-app уведомлением") is implemented by always
-- writing here first; push delivery (if any subscription exists) is a
-- best-effort add-on, not the only way a client learns about a status
-- change.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  seq        BIGSERIAL,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  -- post_published | post_failed | post_pending_approval | video_completed | video_failed
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  related_id TEXT,
  is_read    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_tenant ON notifications(tenant_id, created_at);

-- ---- Auth (Логика Б: public self-serve signup, additive to the existing
-- staff-assisted POST /api/tenants + API key flow, which is untouched and
-- stays the path internal demos use). email+password login for a real
-- dashboard, on its own tenant — one user per tenant for now (nothing here
-- enforces that beyond signup always creating both together; tenant_id is
-- a plain FK, not unique, so a future multi-user-per-tenant invite flow
-- doesn't need a schema change). password_hash is bcrypt — unlike
-- api_keys.key_hash (SHA-256, see apiKeys.ts), a human-chosen password
-- needs a slow, salted KDF to resist offline brute-forcing.
-- Transcripts, keyed by the audio itself.
--
-- Recognition is not deterministic: the audio model hears the same file
-- slightly differently on each pass, which is what makes the ensemble work
-- but also means re-rendering a clip produced different captions every time.
-- Keyed by a hash of the extracted audio, the same source always yields the
-- same words — and is never paid for twice.
--
-- Not per tenant: the key is the content, and two tenants uploading the same
-- file get the same transcript, which is correct and saves the second bill.
-- Nothing tenant-specific is stored, only what was said.
CREATE TABLE transcript_cache (
  audio_hash  TEXT PRIMARY KEY,
  words       JSONB NOT NULL,
  text        TEXT NOT NULL,
  language    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Proof that a render worker is alive, so a queued job can say which of the
-- two things is happening: waiting its turn, or waiting for a process that
-- is not there. Without it both look identical — "в очереди" forever — and a
-- stopped worker is discovered by a customer rather than by us.
--
-- One row per kind, not per process: the question a queued job asks is
-- whether ANY worker is running, so several of them overwriting the same row
-- is the correct answer, not a collision.
CREATE TABLE worker_heartbeats (
  worker_kind  TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- Consecutive failed sign-ins, and when the account stops accepting
  -- attempts. The IP-based rate limit alone does not protect an account:
  -- spread across ten addresses it still allows ~1900 guesses a day at one
  -- password, which is well inside reach for anything a person chose.
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_tenant ON users(tenant_id);

-- Email identity is case-insensitive (api.ts normalizes to lower(trim())
-- before every insert/lookup) — a plain UNIQUE on the raw column would only
-- enforce that within one exact casing, so a future write path that skips
-- the app-level normalization could still create 'User@x.com' and
-- 'user@x.com' as two accounts. Same two-layer shape as
-- idx_triggers_bot_keyword_unique above: the DB constraint is the real
-- guard, app-level normalization is the fast/friendly path.
CREATE UNIQUE INDEX idx_users_email_unique ON users (lower(trim(email)));
