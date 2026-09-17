-- Organisations (suppliers and factories), attendees and their links.
-- Only the server (service_role via the secret key) may touch these objects.

create or replace function public.make_match_key(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(replace(lower(p_name), '&', ' and '), '[^a-z0-9 ]', ' ', 'g'),
        '\m(ltd|limited)\M', ' ', 'g'),
      '\s+', ' ', 'g'))
$$;

create table public.organisations (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('supplier', 'factory')),
  name text not null check (length(btrim(name)) > 0),
  match_key text generated always as (public.make_match_key(name)) stored,
  source text not null check (source in ('list', 'attendee')),
  status text not null check (status in ('approved', 'pending')),
  created_at timestamptz not null default now(),
  constraint organisations_kind_match_key_key unique (kind, match_key)
);

create table public.attendees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text not null,
  from_type text not null check (from_type in ('supplier', 'factory')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index attendees_email_lower_key on public.attendees (lower(email));

create table public.attendee_orgs (
  attendee_id uuid not null references public.attendees (id) on delete cascade,
  org_id bigint not null references public.organisations (id),
  code text not null,
  primary key (attendee_id, org_id)
);
create index attendee_orgs_org_id_idx on public.attendee_orgs (org_id);

create view public.org_status with (security_invoker = true) as
select
  o.id,
  o.kind,
  o.name,
  o.source,
  o.status,
  o.created_at,
  (count(ao.attendee_id) filter (where a.from_type = o.kind))::int as seats_used,
  count(ao.attendee_id)::int as linked_count
from public.organisations o
left join public.attendee_orgs ao on ao.org_id = o.id
left join public.attendees a on a.id = ao.attendee_id
group by o.id;

alter table public.organisations enable row level security;
alter table public.attendees enable row level security;
alter table public.attendee_orgs enable row level security;

revoke all on table public.organisations, public.attendees, public.attendee_orgs, public.org_status
  from anon, authenticated;
grant all on table public.organisations, public.attendees, public.attendee_orgs, public.org_status
  to service_role;

revoke execute on function public.make_match_key(text) from public, anon, authenticated;
grant execute on function public.make_match_key(text) to service_role;
