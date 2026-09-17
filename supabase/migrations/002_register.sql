-- Registration. All checks and writes happen in one transaction.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

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
    end if;

    if not (v_org_id = any (v_ids)) then
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

  select jsonb_agg(o.name order by o.name) into v_full
    from public.organisations o
   where o.id = any (v_ids)
     and o.kind = v_from
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
    insert into public.attendees (name, email, phone, from_type)
    values (btrim(p->>'name'), btrim(p->>'email'), btrim(p->>'phone'), p->>'from_type')
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

revoke execute on function private.prepare_registration(jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function private.prepare_registration(jsonb, uuid, boolean) to service_role;
revoke execute on function public.register_attendee(jsonb) from public, anon, authenticated;
grant execute on function public.register_attendee(jsonb) to service_role;
