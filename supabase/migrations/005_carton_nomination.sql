-- Carton Nomination Program update.
-- * Per-kind seat limits: supplier 2, factory 1 (charged only on the attending-from side).
-- * organisations.code holds the list code; registration codes are resolved server-side and
--   snapshotted into attendee_orgs.code as before.
-- * from_type gains 'other': no organisation links, no seats, organisation_name 2-150 instead.
-- * Attendees gain designation (required for new registrations) and photo_path (optional).
-- * storage bucket attendee-photos: private, <= 1 MiB, JPEG/PNG only. Only the server's
--   service_role key ever touches it (RLS has no policies for anyone else), so no extra
--   storage policies are needed.

alter table public.organisations
  add column if not exists code text;

alter table public.attendees
  add column if not exists designation text not null default '',
  add column if not exists organisation_name text,
  add column if not exists photo_path text;

alter table public.attendees drop constraint attendees_from_type_check;
alter table public.attendees
  add constraint attendees_from_type_check check (from_type in ('supplier', 'factory', 'other'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attendee-photos', 'attendee-photos', false, 1048576, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- Validates the payload, resolves organisations by id, fills each code from organisations.code,
-- removes duplicates (first entry wins), locks the from-side organisations in id order and
-- checks the per-kind seat limit. Returns [{org_id, code}].
-- Raises VALIDATION, ORG_NOT_FOUND or SEAT_FULL.
create or replace function private.prepare_registration(
  p jsonb,
  p_exclude_attendee uuid,
  p_allow_pending boolean
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_from text := p->>'from_type';
  v_entry jsonb;
  v_kind text;
  v_code text;
  v_org_id bigint;
  v_ids bigint[] := '{}';
  v_codes text[] := '{}';
  v_suppliers int;
  v_factories int;
  v_limit int;
  v_full jsonb;
begin
  if v_from is null or v_from not in ('supplier', 'factory', 'other') then
    raise exception 'VALIDATION' using detail = 'from_type';
  end if;
  if coalesce(btrim(p->>'name'), '') = ''
     or coalesce(btrim(p->>'email'), '') = ''
     or coalesce(btrim(p->>'phone'), '') = ''
     or coalesce(btrim(p->>'designation'), '') = '' then
    raise exception 'VALIDATION' using detail = 'contact';
  end if;
  -- Shape check only; real type/size validation happens in the /api/photos route before upload.
  if p->>'photo_path' is not null and p->>'photo_path'
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$' then
    raise exception 'VALIDATION' using detail = 'photo';
  end if;
  if jsonb_typeof(p->'orgs') is distinct from 'array' then
    raise exception 'VALIDATION' using detail = 'orgs';
  end if;

  -- "Other" attendees belong to no supplier/factory and use no seats.
  if v_from = 'other' then
    if jsonb_array_length(p->'orgs') <> 0
       or char_length(btrim(coalesce(p->>'organisation_name', ''))) not between 2 and 150 then
      raise exception 'VALIDATION' using detail = 'organisation_name';
    end if;
    return '[]'::jsonb;
  end if;

  v_limit := case v_from when 'supplier' then 2 else 1 end;

  select count(*) filter (where e->>'kind' = 'supplier'),
         count(*) filter (where e->>'kind' = 'factory')
    into v_suppliers, v_factories
    from jsonb_array_elements(p->'orgs') as e;
  if (case v_from when 'supplier' then v_suppliers else v_factories end) not between 1 and 10
     or (case v_from when 'supplier' then v_factories else v_suppliers end) > 10
     or v_suppliers + v_factories <> jsonb_array_length(p->'orgs') then
    raise exception 'VALIDATION' using detail = 'orgs';
  end if;

  for v_entry in select value from jsonb_array_elements(p->'orgs') loop
    v_kind := v_entry->>'kind';
    if v_kind not in ('supplier', 'factory')
       or not (v_entry ? 'org_id')
       or (v_entry->>'org_id') !~ '^\d+$' then
      raise exception 'VALIDATION' using detail = 'orgs';
    end if;

    select o.id, coalesce(o.code, '')
      into v_org_id, v_code
      from public.organisations o
     where o.id = (v_entry->>'org_id')::bigint
       and o.kind = v_kind
       and (o.status = 'approved' or p_allow_pending);
    if v_org_id is null then
      raise exception 'ORG_NOT_FOUND' using detail = v_entry->>'org_id';
    end if;

    if array_position(v_ids, v_org_id) is null then
      v_ids := v_ids || v_org_id;
      v_codes := v_codes || v_code;
    end if;
  end loop;

  -- Lock in id order. FOR NO KEY UPDATE serialises seat checks without blocking the
  -- foreign-key checks (FOR KEY SHARE) of registrations from the other side, which
  -- FOR UPDATE would deadlock against.
  perform 1
     from public.organisations o
    where o.id = any (v_ids)
      and o.kind = v_from
    order by o.id
      for no key update;

  -- An edit is only checked at organisations it would newly charge. Where the person already
  -- holds a seat on this side the check is skipped, so edits still work after "merge anyway"
  -- has put an organisation over the limit. (p_exclude_attendee null: nothing is skipped.)
  select jsonb_agg(o.name order by o.name) into v_full
    from public.organisations o
   where o.id = any (v_ids)
     and o.kind = v_from
     and not exists (select 1
                       from public.attendee_orgs ao2
                       join public.attendees a2 on a2.id = ao2.attendee_id
                      where ao2.org_id = o.id
                        and a2.id = p_exclude_attendee
                        and a2.from_type = o.kind)
     and (select count(*)
            from public.attendee_orgs ao
            join public.attendees a on a.id = ao.attendee_id
           where ao.org_id = o.id
             and a.from_type = o.kind
             and a.id is distinct from p_exclude_attendee) >= v_limit;
  if v_full is not null then
    raise exception 'SEAT_FULL'
      using detail = jsonb_build_object('side', v_from, 'orgs', v_full)::text;
  end if;

  return (
    select jsonb_agg(jsonb_build_object('org_id', i.id, 'code', i.code) order by i.ord)
      from unnest(v_ids, v_codes) with ordinality as i (id, code, ord)
  );
end;
$$;

create or replace function public.register_attendee(p jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_orgs jsonb;
  v_id uuid;
begin
  v_orgs := private.prepare_registration(p, null, false);

  begin
    insert into public.attendees (name, email, phone, designation, from_type, organisation_name, photo_path)
    values (btrim(p->>'name'), btrim(p->>'email'), btrim(p->>'phone'), coalesce(btrim(p->>'designation'), ''),
            p->>'from_type',
            case when p->>'from_type' = 'other' then btrim(p->>'organisation_name') end,
            p->>'photo_path')
    returning id into v_id;
  exception when unique_violation then
    raise exception 'DUPLICATE_EMAIL';
  end;

  insert into public.attendee_orgs (attendee_id, org_id, code)
  select v_id, (e->>'org_id')::bigint, e->>'code'
    from jsonb_array_elements(v_orgs) as e;

  return v_id;
end;
$$;

create or replace function public.update_attendee(p_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_orgs jsonb;
  v_old_org_ids bigint[];
begin
  perform 1 from public.attendees where id = p_id for no key update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  v_orgs := private.prepare_registration(p, p_id, true);

  begin
    update public.attendees
       set name = btrim(p->>'name'),
           email = btrim(p->>'email'),
           phone = btrim(p->>'phone'),
           designation = coalesce(btrim(p->>'designation'), ''),
           from_type = p->>'from_type',
           organisation_name = case when p->>'from_type' = 'other' then btrim(p->>'organisation_name') end,
           photo_path = p->>'photo_path',
           updated_at = now()
     where id = p_id;
  exception when unique_violation then
    raise exception 'DUPLICATE_EMAIL';
  end;

  select array_agg(org_id) into v_old_org_ids from public.attendee_orgs where attendee_id = p_id;
  delete from public.attendee_orgs where attendee_id = p_id;
  insert into public.attendee_orgs (attendee_id, org_id, code)
  select p_id, (e->>'org_id')::bigint, e->>'code'
    from jsonb_array_elements(v_orgs) as e;

  perform private.delete_orphan_pending(v_old_org_ids);
end;
$$;

create or replace function public.merge_org(p_source bigint, p_target bigint, p_allow_over_limit boolean)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_source public.organisations;
  v_target public.organisations;
  v_count int;
  v_limit int;
begin
  -- Same lock order as prepare_registration (by id) to avoid deadlocks; see 004 for why
  -- the source takes FOR UPDATE and the target FOR NO KEY UPDATE.
  if p_source < p_target then
    perform 1 from public.organisations where id = p_source for update;
    perform 1 from public.organisations where id = p_target for no key update;
  else
    perform 1 from public.organisations where id = p_target for no key update;
    perform 1 from public.organisations where id = p_source for update;
  end if;

  select * into v_source from public.organisations where id = p_source;
  if v_source.id is null or v_source.status <> 'pending' then
    raise exception 'NOT_FOUND';
  end if;

  select * into v_target from public.organisations where id = p_target;
  if v_target.id is null or v_target.status <> 'approved' or v_target.kind <> v_source.kind then
    raise exception 'VALIDATION' using detail = 'target';
  end if;

  select count(distinct a.id)::int into v_count
    from public.attendee_orgs ao
    join public.attendees a on a.id = ao.attendee_id
   where ao.org_id in (p_source, p_target)
     and a.from_type = v_target.kind;

  v_limit := case v_target.kind when 'supplier' then 2 else 1 end;
  if v_count > v_limit and not coalesce(p_allow_over_limit, false) then
    raise exception 'MERGE_OVER_LIMIT'
      using detail = jsonb_build_object('target', v_target.name, 'side', v_target.kind, 'count', v_count)::text;
  end if;

  insert into public.attendee_orgs (attendee_id, org_id, code)
  select ao.attendee_id, p_target, ao.code
    from public.attendee_orgs ao
   where ao.org_id = p_source
  on conflict (attendee_id, org_id) do nothing;

  delete from public.attendee_orgs where org_id = p_source;
  delete from public.organisations where id = p_source;

  return v_count;
end;
$$;
