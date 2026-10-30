-- Per-session questions, asked by attendees from the QR on their own identity card.
--
-- During each session people in the room have questions and nothing captures them, so after the
-- day nobody can say who asked what. These tables are that record. The feature is collection,
-- not moderation: there is no public feed, no voting, and no answer tracking.
--
-- A session belongs to the EVENT, not to an event day. Its starts_at is an absolute instant and
-- already carries the date, so a day reference would store the same fact twice and add a join to
-- every read. Q&A is not scoped by day at all: attendance on any day of the event unlocks every
-- session on the programme.

create table public.event_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  -- Printed running order, breaks included, so the attendee's list reads like the programme.
  position int not null,
  title text not null check (char_length(btrim(title)) between 2 and 200),
  kind text not null default 'session' check (kind in ('session', 'break')),
  starts_at timestamptz not null,
  -- Null for the open-ended closing row ("17:30 Onwards").
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, position),
  check (ends_at is null or ends_at > starts_at)
);
create index event_sessions_event_id_starts_at_idx on public.event_sessions (event_id, starts_at);

create table public.session_questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.event_sessions (id) on delete cascade,
  registration_id uuid not null references public.event_registrations (id) on delete cascade,
  -- char_length, not octet_length: 10000 Bengali characters is roughly 30 KB and must be accepted.
  body text not null check (char_length(btrim(body)) between 3 and 10000),
  asked_at timestamptz not null default now()
);
create index session_questions_session_id_asked_at_idx on public.session_questions (session_id, asked_at);
create index session_questions_registration_id_idx on public.session_questions (registration_id);

-- Null means "follow the clock". A value is an administrator's override, and it stops counting
-- once that session's ends_at passes, so a pin set and forgotten before lunch does not collect
-- the whole afternoon's questions. The presence of the value IS the override; there is no mode
-- column. It lives on the event rather than the day because Q&A is not day-scoped.
alter table public.events
  add column live_session_id uuid references public.event_sessions (id) on delete set null;

alter table public.event_sessions enable row level security;
alter table public.session_questions enable row level security;

revoke all on table public.event_sessions, public.session_questions from anon, authenticated;
grant all on table public.event_sessions, public.session_questions to service_role;
