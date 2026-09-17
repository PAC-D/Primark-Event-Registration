-- Hardening after the final review:
-- * edits are not re-checked at organisations where the person already holds a seat on the same
--   side, so people at an organisation merged over the limit can still be edited;
-- * NULL-safe organisation lookups and merge flag;
-- * lock modes that do not block unrelated foreign-key checks;
-- * orphan cleanup limited to the organisations the attendee was linked to.

-- Validates the payload, resolves typed names to organisations (creating pending ones),
-- removes duplicate organisations (first code wins), locks every organisation that would
-- use a seat and checks the limit of 2.
-- Returns [{org_id, code}]. Raises VALIDATION, ORG_NOT_FOUND or SEAT_FULL.
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
  v_other text;
  v_org_id bigint;
  v_ids bigint[] := '{}';
  v_codes text[] := '{}';
  v_suppliers int;
  v_factories int;
  v_full jsonb;
begin
  if v_from is null or v_from not in ('supplier', 'factory') then
    raise exception 'VALIDATION' using detail = 'from_type';
  end if;
  if coalesce(btrim(p->>'name'), '') = ''
     or coalesce(btrim(p->>'email'), '') = ''
     or coalesce(btrim(p->>'phone'), '') = '' then
    raise exception 'VALIDATION' using detail = 'contact';
  end if;
  if jsonb_typeof(p->'orgs') is distinct from 'array' then
    raise exception 'VALIDATION' using detail = 'orgs';
  end if;

  select count(*) filter (where e->>'kind' = 'supplier'),
         count(*) filter (where e->>'kind' = 'factory')
    into v_suppliers, v_factories
    from jsonb_array_elements(p->'orgs') as e;
  if v_suppliers not between 1 and 10
     or v_factories not between 1 and 10
     or v_suppliers + v_factories <> jsonb_array_length(p->'orgs') then
    raise exception 'VALIDATION' using detail = 'orgs';
  end if;

  for v_entry in select value from jsonb_array_elements(p->'orgs') loop
    v_kind := v_entry->>'kind';
    v_code := btrim(coalesce(v_entry->>'code', ''));
    if v_code = '' or (v_entry ? 'org_id') = (v_entry ? 'other_name') then
      raise exception 'VALIDATION' using detail = 'orgs';
    end if;

    if v_entry ? 'org_id' then
      select o.id into v_org_id
        from public.organisations o
       where o.id = (v_entry->>'org_id')::bigint
         and o.kind = v_kind
         and (o.status = 'approved' or p_allow_pending);
      if v_org_id is null then
        raise exception 'ORG_NOT_FOUND' using detail = v_entry->>'org_id';
      end if;
    else
      v_other := btrim(coalesce(v_entry->>'other_name', ''));
      if public.make_match_key(v_other) = '' then
        raise exception 'VALIDATION' using detail = 'other_name';
      end if;
      insert into public.organisations (kind, name, source, status)
      values (v_kind, v_other, 'attendee', 'pending')
      on conflict (kind, match_key) do nothing;
      select o.id into v_org_id
        from public.organisations o
       where o.kind = v_kind
         and o.match_key = public.make_match_key(v_other);
      -- The row can vanish between the insert and the select (e.g. a concurrent orphan cleanup).
      if v_org_id is null then
        raise exception 'ORG_NOT_FOUND';
      end if;
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
             and a.id is distinct from p_exclude_attendee) >= 2;
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

-- Deletes the given organisations if they are pending and have no links left.
create or replace function private.delete_orphan_pending(p_org_ids bigint[])
returns void
language sql
set search_path = ''
as $$
  delete from public.organisations o
   where o.id = any (p_org_ids)
     and o.status = 'pending'
     and not exists (select 1 from public.attendee_orgs ao where ao.org_id = o.id);
$$;

revoke execute on function private.delete_orphan_pending(bigint[]) from public, anon, authenticated;
grant execute on function private.delete_orphan_pending(bigint[]) to service_role;

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
           from_type = p->>'from_type',
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

create or replace function public.delete_attendee(p_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_old_org_ids bigint[];
begin
  -- Lock first so the links read below cannot change before the delete.
  perform 1 from public.attendees where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  select array_agg(org_id) into v_old_org_ids from public.attendee_orgs where attendee_id = p_id;
  delete from public.attendees where id = p_id;
  perform private.delete_orphan_pending(v_old_org_ids);
end;
$$;

drop function private.delete_orphan_pending();

create or replace function public.merge_org(p_source bigint, p_target bigint, p_allow_over_limit boolean)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_source public.organisations;
  v_target public.organisations;
  v_count int;
begin
  -- Lock both rows in ascending id order, the order prepare_registration uses, to avoid deadlocks.
  -- The source is about to be deleted, so it takes FOR UPDATE (this also waits for registrations
  -- adding links to it). The target takes FOR NO KEY UPDATE like a seat check, which serialises it
  -- with registrations charging it without blocking other-side foreign-key checks.
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

  if v_count > 2 and not coalesce(p_allow_over_limit, false) then
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
