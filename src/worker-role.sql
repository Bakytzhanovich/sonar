-- Least-privilege database role for the render worker.
--
-- Why this exists: the worker runs ffmpeg over files uploaded by users, and
-- ffmpeg parses untrusted containers for a living — it has a long history of
-- memory-safety bugs in exactly that code. If a crafted file ever turns into
-- code execution there, the blast radius is whatever that process can reach.
-- Today that is the same database role the API uses: every table, including
-- users (password hashes) and api_keys, for every tenant.
--
-- It needs three tables. This grants those and nothing else, so the same
-- compromise yields render jobs and notifications instead of the customer
-- database.
--
-- Run once against the production database as its owner, then set
-- DATABASE_URL for the worker service to this role's credentials. The API
-- keeps its own, unchanged.
--
--   psql "$ADMIN_DATABASE_URL" -v password="'...'" -f src/worker-role.sql
--
-- Not run automatically at boot: creating roles needs privileges the app
-- itself must not hold, which is the entire point.

CREATE ROLE sonar_worker LOGIN PASSWORD :password;

-- The database name differs by host: 'sonar' locally, 'neondb' on Neon, and
-- whatever a managed provider chose elsewhere. current_database() avoids
-- having to remember which, since this always runs connected to the one
-- being granted.
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO sonar_worker', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO sonar_worker;

-- Claims jobs, records stages and artifacts, writes the finished output.
GRANT SELECT, UPDATE ON video_edit_jobs TO sonar_worker;

-- Tells the owner their render is done or failed.
GRANT INSERT ON notifications TO sonar_worker;

-- Reads browser push endpoints to deliver that notification.
GRANT SELECT ON push_subscriptions TO sonar_worker;

-- Recognised speech, keyed by the audio's hash. The worker both reads it
-- (to avoid paying for the same file twice, and to give the same clip the
-- same captions every time) and writes it after a fresh transcription.
-- No UPDATE: entries are written once and never revised — overwriting one
-- would break the promise the table exists to make.
GRANT SELECT, INSERT ON transcript_cache TO sonar_worker;

-- Says "a worker is alive" so a queued job can tell waiting-its-turn apart
-- from waiting-for-nobody. One shared row, so UPDATE as well as INSERT.
GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO sonar_worker;

-- Sequences behind BIGSERIAL columns on the tables above.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO sonar_worker;

-- Deliberately NOT granted, and each for a reason:
--   users, api_keys     — credentials; the worker never authenticates anyone
--   tenants, subscribers, messages, notes — customer data unrelated to video
--   bots, flows, triggers, flow_runs      — Module 1, a different subsystem
--   DELETE on anything  — the worker has no reason to remove a row, and
--                         withholding it means a compromise cannot erase
--                         evidence of itself
