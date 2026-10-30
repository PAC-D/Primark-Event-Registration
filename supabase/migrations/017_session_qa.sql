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

-- The single write path for a question. One transaction resolves the scanned credential to a
-- registration, checks every gate, applies the cooldown and inserts.
--
-- Statuses are returned rather than raised (as check_in_registration does) so the attendee's
-- page can show a specific sentence instead of a generic failure. Only malformed arguments
-- raise, because those are a bug or an attack, never something an attendee can cause.
--
-- The attendance check accepts a check-in on ANY day of the event: Q&A is not day-scoped.
--
-- The event's status gates asking, the same way check_in_registration requires 'open'. A card
-- QR lives in a phone's URL history forever, so without this an open write endpoint would
-- outlive the seminar by years. The per-day check-in window is deliberately NOT applied:
-- asking about the morning at 18:00 is the point of the feature.
create or replace function public.ask_session_question(
  p_credential_hash text,
  p_session_id uuid,
  p_body text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_cooldown constant interval := interval '3 seconds';
  v_body text := btrim(coalesce(p_body, ''));
  v_credential public.registration_credentials;
  v_registration public.event_registrations;
  v_session public.event_sessions;
  v_event public.events;
  v_question public.session_questions;
begin
  if p_credential_hash !~ '^[0-9a-f]{64}$'
     or p_session_id is null
     or char_length(v_body) not between 3 and 10000 then
    raise exception 'VALIDATION' using detail = 'question';
  end if;

  select * into v_credential
    from public.registration_credentials c
   where c.token_hash = p_credential_hash
      or c.fallback_code_hash = p_credential_hash;
  if v_credential.id is null then
    return jsonb_build_object('status', 'INVALID');
  end if;

  select * into v_registration
    from public.event_registrations r
   where r.id = v_credential.registration_id;
  if v_credential.status <> 'active' or v_registration.status <> 'confirmed' then
    return jsonb_build_object('status', 'REVOKED');
  end if;

  select * into v_session from public.event_sessions s where s.id = p_session_id;
  if v_session.id is null then
    return jsonb_build_object('status', 'INVALID');
  end if;
  if v_session.event_id <> v_registration.event_id then
    return jsonb_build_object('status', 'WRONG_EVENT');
  end if;

  select * into v_event from public.events e where e.id = v_session.event_id;
  if v_event.status <> 'open' then
    return jsonb_build_object('status', 'CLOSED');
  end if;

  if v_session.kind <> 'session' then
    return jsonb_build_object('status', 'BREAK');
  end if;

  if not exists (
    select 1
      from public.attendance a
      join public.event_days d on d.id = a.event_day_id
     where a.registration_id = v_registration.id
       and d.event_id = v_registration.event_id
  ) then
    return jsonb_build_object('status', 'NOT_CHECKED_IN');
  end if;

  -- Not a quota: there is no cap on how many questions one person asks. This only stops a
  -- script hammering a public write endpoint, and a human typing never meets it.
  if exists (
    select 1 from public.session_questions q
     where q.registration_id = v_registration.id
       and q.asked_at > now() - v_cooldown
  ) then
    return jsonb_build_object('status', 'TOO_FAST');
  end if;

  insert into public.session_questions (session_id, registration_id, body)
  values (v_session.id, v_registration.id, v_body)
  returning * into v_question;

  return jsonb_build_object(
    'status', 'ASKED',
    'question_id', v_question.id,
    'asked_at', v_question.asked_at,
    'session_id', v_session.id,
    'session_title', v_session.title
  );
end;
$$;

revoke execute on function public.ask_session_question(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.ask_session_question(text, uuid, text) to service_role;

-- Sets or clears the live-session override. A function rather than a plain update from Express
-- because "the session must belong to this event and must not be a break" is a cross-table rule
-- a CHECK constraint cannot express.
create or replace function public.set_live_session(
  p_event_id uuid,
  p_session_id uuid
) returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.events where id = p_event_id for no key update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  if p_session_id is not null and not exists (
    select 1 from public.event_sessions s
     where s.id = p_session_id
       and s.event_id = p_event_id
       and s.kind = 'session'
  ) then
    raise exception 'VALIDATION' using detail = 'session';
  end if;

  update public.events set live_session_id = p_session_id where id = p_event_id;
end;
$$;

create or replace function public.delete_session_question(p_id uuid) returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.session_questions where id = p_id;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
end;
$$;

revoke execute on function public.set_live_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_live_session(uuid, uuid) to service_role;
revoke execute on function public.delete_session_question(uuid) from public, anon, authenticated;
grant execute on function public.delete_session_question(uuid) to service_role;
