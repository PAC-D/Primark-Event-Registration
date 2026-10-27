-- Admin edits use the same optional fields and unrestricted organisation capacity as admin adds.
-- Public registration continues to use private.prepare_registration and its strict requirements.

create or replace function public.update_attendee(p_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_from text := coalesce(nullif(btrim(p->>'from_type'), ''), 'other');
  v_entry jsonb;
  v_kind text;
  v_code text;
  v_org_id bigint;
  v_ids bigint[] := '{}';
  v_codes text[] := '{}';
  v_suppliers int;
  v_factories int;
  v_old_org_ids bigint[];
begin
  perform 1 from public.attendees where id = p_id for no key update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  if v_from not in ('supplier', 'factory', 'other') then
    raise exception 'VALIDATION' using detail = 'from_type';
  end if;
  if char_length(btrim(coalesce(p->>'name', ''))) > 100
     or char_length(btrim(coalesce(p->>'email', ''))) > 254
     or char_length(btrim(coalesce(p->>'phone', ''))) > 30
     or char_length(btrim(coalesce(p->>'designation', ''))) > 100 then
    raise exception 'VALIDATION' using detail = 'contact';
  end if;
  if p->>'photo_path' is not null and p->>'photo_path'
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$' then
    raise exception 'VALIDATION' using detail = 'photo';
  end if;
  if jsonb_typeof(p->'orgs') is distinct from 'array' then
    raise exception 'VALIDATION' using detail = 'orgs';
  end if;

  if v_from = 'other' then
    if jsonb_array_length(p->'orgs') <> 0
       or char_length(btrim(coalesce(p->>'organisation_name', ''))) > 150 then
      raise exception 'VALIDATION' using detail = 'organisation_name';
    end if;
  else
    select count(*) filter (where e->>'kind' = 'supplier'),
           count(*) filter (where e->>'kind' = 'factory')
      into v_suppliers, v_factories
      from jsonb_array_elements(p->'orgs') as e;
    if v_suppliers > 10
       or v_factories > 10
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
         and o.kind = v_kind;
      if v_org_id is null then
        raise exception 'ORG_NOT_FOUND' using detail = v_entry->>'org_id';
      end if;

      if array_position(v_ids, v_org_id) is null then
        v_ids := v_ids || v_org_id;
        v_codes := v_codes || v_code;
      end if;
    end loop;
  end if;

  begin
    update public.attendees
       set name = btrim(coalesce(p->>'name', '')),
           email = btrim(coalesce(p->>'email', '')),
           phone = btrim(coalesce(p->>'phone', '')),
           designation = btrim(coalesce(p->>'designation', '')),
           from_type = v_from,
           organisation_name = case when v_from = 'other'
             then btrim(coalesce(p->>'organisation_name', '')) end,
           photo_path = p->>'photo_path',
           updated_at = now()
     where id = p_id;
  exception when unique_violation then
    raise exception 'DUPLICATE_EMAIL';
  end;

  select array_agg(org_id) into v_old_org_ids
    from public.attendee_orgs where attendee_id = p_id;
  delete from public.attendee_orgs where attendee_id = p_id;
  insert into public.attendee_orgs (attendee_id, org_id, code)
  select p_id, i.id, i.code
    from unnest(v_ids, v_codes) as i (id, code);

  perform private.delete_orphan_pending(v_old_org_ids);
end;
$$;

revoke execute on function public.update_attendee(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.update_attendee(uuid, jsonb) to service_role;
