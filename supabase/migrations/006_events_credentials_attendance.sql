-- Event-scoped registrations, revocable QR credentials, and daily attendance.
-- Existing attendee tables remain the registration UI's source of truth so this migration
-- is backward-compatible with the completed registration/admin application.

create table public.events (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{2,49}$'),
  name text not null check (char_length(btrim(name)) between 2 and 150),
  subtitle text,
  timezone text not null default 'Asia/Dhaka',
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'open', 'closed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table public.event_days (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  event_date date not null,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  check_in_opens_at timestamptz,
  check_in_closes_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, event_date),
  check (check_in_closes_at is null or check_in_opens_at is null or check_in_closes_at > check_in_opens_at)
);

create table public.event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  attendee_id uuid not null references public.attendees (id) on delete cascade,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, attendee_id)
);
create index event_registrations_attendee_id_idx on public.event_registrations (attendee_id);

-- Snapshot the organisation displayed on a card even if the catalogue entry is later merged.
create table public.registration_orgs (
  registration_id uuid not null references public.event_registrations (id) on delete cascade,
  org_id bigint references public.organisations (id) on delete set null,
  kind text not null check (kind in ('supplier', 'factory')),
  name text not null,
  code text,
  primary key (registration_id, kind, name)
);
create index registration_orgs_org_id_idx on public.registration_orgs (org_id);

-- Credential history is retained. A partial unique index permits one active credential while
-- allowing old QR codes to return REVOKED after rotation.
create table public.registration_credentials (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.event_registrations (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  fallback_code_hash text not null unique check (fallback_code_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  issued_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index registration_credentials_one_active_idx
  on public.registration_credentials (registration_id) where status = 'active';

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.event_registrations (id) on delete cascade,
  event_day_id uuid not null references public.event_days (id) on delete cascade,
  first_scanned_at timestamptz not null default now(),
  scanned_at_device timestamptz not null,
  received_at timestamptz not null default now(),
  device_id text not null check (char_length(btrim(device_id)) between 2 and 100),
  scan_id uuid not null unique,
  source text not null check (source in ('online', 'offline')),
  unique (registration_id, event_day_id)
);
create index attendance_event_day_id_idx on public.attendance (event_day_id);

alter table public.events enable row level security;
alter table public.event_days enable row level security;
alter table public.event_registrations enable row level security;
alter table public.registration_orgs enable row level security;
alter table public.registration_credentials enable row level security;
alter table public.attendance enable row level security;

revoke all on table public.events, public.event_days, public.event_registrations,
  public.registration_orgs, public.registration_credentials, public.attendance
  from anon, authenticated;
grant all on table public.events, public.event_days, public.event_registrations,
  public.registration_orgs, public.registration_credentials, public.attendance
  to service_role;

-- If this is applied to an already-live registration database, create a draft event and
-- backfill its existing attendees. A fresh database remains event-free until explicitly seeded.
do $$
declare
  v_event_id uuid;
begin
  if exists (select 1 from public.attendees) then
    insert into public.events (code, name, subtitle, timezone, status)
    values ('current-event', 'Bangladesh Origin', 'Migrated registrations', 'Asia/Dhaka', 'draft')
    returning id into v_event_id;

    insert into public.event_registrations (event_id, attendee_id)
    select v_event_id, a.id from public.attendees a;

    insert into public.registration_orgs (registration_id, org_id, kind, name, code)
    select er.id, o.id, o.kind, o.name, ao.code
      from public.event_registrations er
      join public.attendee_orgs ao on ao.attendee_id = er.attendee_id
      join public.organisations o on o.id = ao.org_id
     where er.event_id = v_event_id;
  end if;
end
$$;

create or replace function public.issue_registration_credential(
  p_registration_id uuid,
  p_token_hash text,
  p_fallback_code_hash text
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_fallback_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'VALIDATION' using detail = 'credential_hash';
  end if;

  perform 1
    from public.event_registrations
   where id = p_registration_id
     and status = 'confirmed'
     for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  update public.registration_credentials
     set status = 'revoked', revoked_at = now()
   where registration_id = p_registration_id
     and status = 'active';

  insert into public.registration_credentials (registration_id, token_hash, fallback_code_hash)
  values (p_registration_id, p_token_hash, p_fallback_code_hash)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.check_in_registration(
  p_credential_hash text,
  p_event_day_id uuid,
  p_scan_id uuid,
  p_device_id text,
  p_scanned_at_device timestamptz,
  p_source text default 'online'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_credential public.registration_credentials;
  v_registration public.event_registrations;
  v_day public.event_days;
  v_event public.events;
  v_attendee public.attendees;
  v_attendance_id uuid;
  v_inserted boolean := false;
  v_organisation text;
begin
  if p_credential_hash !~ '^[0-9a-f]{64}$'
     or p_scan_id is null
     or char_length(btrim(coalesce(p_device_id, ''))) not between 2 and 100
     or p_scanned_at_device is null
     or p_source not in ('online', 'offline') then
    raise exception 'VALIDATION' using detail = 'scan';
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

  select * into v_day from public.event_days d where d.id = p_event_day_id;
  if v_day.id is null or v_day.event_id <> v_registration.event_id then
    return jsonb_build_object('status', 'WRONG_EVENT');
  end if;

  select * into v_event from public.events e where e.id = v_day.event_id;
  if v_event.status <> 'open'
     or (v_day.check_in_opens_at is not null and v_now < v_day.check_in_opens_at)
     or (v_day.check_in_closes_at is not null and v_now > v_day.check_in_closes_at) then
    return jsonb_build_object('status', 'OUTSIDE_CHECKIN_WINDOW');
  end if;

  -- A repeated scan_id is idempotent only for the same registration and day.
  select a.id into v_attendance_id
    from public.attendance a
   where a.scan_id = p_scan_id
     and a.registration_id = v_registration.id
     and a.event_day_id = v_day.id;
  if v_attendance_id is null and exists (select 1 from public.attendance a where a.scan_id = p_scan_id) then
    return jsonb_build_object('status', 'INVALID');
  end if;

  if v_attendance_id is null then
    insert into public.attendance (
      registration_id, event_day_id, scanned_at_device, device_id, scan_id, source
    ) values (
      v_registration.id, v_day.id, p_scanned_at_device, btrim(p_device_id), p_scan_id, p_source
    )
    on conflict do nothing
    returning id into v_attendance_id;
    v_inserted := v_attendance_id is not null;
  end if;

  select * into v_attendee from public.attendees a where a.id = v_registration.attendee_id;
  select string_agg(ro.name, ', ' order by ro.kind, ro.name) into v_organisation
    from public.registration_orgs ro where ro.registration_id = v_registration.id;
  v_organisation := coalesce(v_organisation, v_attendee.organisation_name);

  return jsonb_build_object(
    'status', case when v_inserted then 'CHECKED_IN' else 'ALREADY_CHECKED_IN' end,
    'registration_id', v_registration.id,
    'name', v_attendee.name,
    'designation', v_attendee.designation,
    'organisation', v_organisation,
    'event', v_event.name,
    'day', v_day.label
  );
end;
$$;

revoke execute on function public.issue_registration_credential(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.issue_registration_credential(uuid, text, text) to service_role;
revoke execute on function public.check_in_registration(text, uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.check_in_registration(text, uuid, uuid, text, timestamptz, text)
  to service_role;

