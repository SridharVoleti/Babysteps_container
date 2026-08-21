-- ============================================================
-- Babysteps — container progress/session-finalize schema (PA-001 / SR-004)
--
-- Backs the Babysteps Platform API's progress.checkpoint/progress.restore and
-- session.finalize operations (app/api/v1/progress/**, app/api/v1/session-finalize/**).
-- Deliberately separate from ChessMaster's pre-existing student_progress table (which is
-- keyed to auth.users, a different identity space — see 0001_authz_postgres.sql's header
-- comment). learner_id here is students.id from 0001.
-- ============================================================

-- One row per (learner, app, release) — the current PA-001 checkpoint.
create table if not exists app_progress (
  learner_id                 text not null references students(id) on delete cascade,
  app_id                     text not null,
  release_id                 text not null,
  app_progress_schema_version text not null,
  app_progress                jsonb not null default '{}'::jsonb,
  progress_version            bigint not null default 0,
  updated_at                  timestamptz not null default now(),
  primary key (learner_id, app_id, release_id)
);
create index if not exists idx_app_progress_learner on app_progress(learner_id, app_id);

-- One row per finalized (SR-004-completed) session.
create table if not exists app_sessions (
  session_id     text primary key,
  learner_id     text not null references students(id) on delete cascade,
  app_id         text not null,
  release_id     text not null,
  final_progress jsonb not null default '{}'::jsonb,
  final_status   text not null default 'completed',
  finalized_at   timestamptz not null default now()
);
create index if not exists idx_app_sessions_learner on app_sessions(learner_id, app_id);

alter table app_progress enable row level security;
alter table app_sessions enable row level security;
