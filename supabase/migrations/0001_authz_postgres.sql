-- ============================================================
-- Babysteps — authz schema (Postgres port of ChessMaster's lib/authz SQLite schema)
-- Run in Supabase SQL Editor or via `supabase db push`.
--
-- This is the container's learner/session authority: students.id becomes the SB-001
-- `learnerId`, and usage_sessions (day-booking + timed-session quota) is the source a
-- launch context is issued from (see app/api/v1/sessions/route.ts). Every table here is
-- written/read only by lib/platform/authz (service-role key) via app/api/v1/**, never
-- directly by apps/chessmaster or by the host/runtime layer (CC-003).
--
-- Deliberately independent of Supabase Auth (auth.users) / student_progress / game_attempts
-- — those remain ChessMaster's pre-existing, disconnected identity system and are left
-- untouched by this integration (see BabyStepsIndia-ContainerApp README / integration report
-- for the stated reconciliation gap).
-- ============================================================

create table if not exists students (
  id            text primary key,
  email         text not null,
  display_name  text not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);
create unique index if not exists idx_students_email_lower on students (lower(email));

create table if not exists auth_tokens (
  token_hash text primary key,
  student_id text not null references students(id) on delete cascade,
  issued_at  timestamptz not null,
  expires_at timestamptz not null
);
create index if not exists idx_auth_tokens_student on auth_tokens(student_id);

-- One reserved calendar day per student per date.
create table if not exists bookings (
  id         text primary key,
  student_id text not null references students(id) on delete cascade,
  slot_date  date not null,
  created_at timestamptz not null default now(),
  unique (student_id, slot_date)
);
create index if not exists idx_bookings_student on bookings(student_id, slot_date);

-- A usage session counts against the day's quota once started,
-- even if it is ended early or left to expire.
create table if not exists usage_sessions (
  id         text primary key,
  student_id text not null references students(id) on delete cascade,
  booking_id text not null references bookings(id) on delete cascade,
  started_at timestamptz not null,
  expires_at timestamptz not null,
  ended_at   timestamptz
);
create index if not exists idx_usage_sessions_booking on usage_sessions(booking_id);
create index if not exists idx_usage_sessions_student on usage_sessions(student_id);

-- RLS enabled, no policies: only the service-role key (lib/platform/authz, server-side
-- only) may read/write these tables. The anon/authenticated Supabase keys get nothing.
alter table students       enable row level security;
alter table auth_tokens    enable row level security;
alter table bookings       enable row level security;
alter table usage_sessions enable row level security;
