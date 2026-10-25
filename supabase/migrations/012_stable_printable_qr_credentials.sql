-- Restore downloadable QR credentials after identity-card generation was retired in migration 011.
-- The encrypted payload makes reprints stable; token/fallback hashes remain authoritative for scans.

alter table public.registration_credentials
  add column print_payload text;

-- The current application has one active registration event. Keep later public registrations
-- attached to that event so every attendee shown in the admin registration tab can receive a QR.
insert into public.events (code, name, subtitle, timezone, status)
select 'current-event', 'Primark Carton Nomination Program', 'Bangladesh Origin', 'Asia/Dhaka', 'draft'
where not exists (select 1 from public.events);

create or replace function private.current_registration_event_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select e.id
    from public.events e
   where e.status <> 'archived'
   order by case e.status when 'open' then 0 when 'draft' then 1 else 2 end,
            e.created_at desc, e.id
   limit 1
$$;

create or replace function private.attach_attendee_to_current_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_event_id uuid := private.current_registration_event_id();
begin
  if v_event_id is not null then
    insert into public.event_registrations (event_id, attendee_id)
    values (v_event_id, new.id)
    on conflict (event_id, attendee_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists attendees_attach_current_event on public.attendees;
create trigger attendees_attach_current_event
after insert on public.attendees
for each row execute function private.attach_attendee_to_current_event();

-- Backfill attendees created after migration 006, before the trigger above existed.
insert into public.event_registrations (event_id, attendee_id)
select private.current_registration_event_id(), a.id
  from public.attendees a
where private.current_registration_event_id() is not null
on conflict (event_id, attendee_id) do nothing;

create or replace function private.sync_registration_org_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.registration_orgs ro
     using public.event_registrations er
     where er.id = ro.registration_id
       and er.attendee_id = old.attendee_id
       and ro.org_id = old.org_id;
    return old;
  end if;

  insert into public.registration_orgs (registration_id, org_id, kind, name, code)
  select er.id, o.id, o.kind, o.name, new.code
    from public.event_registrations er
    join public.organisations o on o.id = new.org_id
   where er.attendee_id = new.attendee_id
  on conflict (registration_id, kind, name)
  do update set org_id = excluded.org_id, code = excluded.code;
  return new;
end;
$$;

drop trigger if exists attendee_orgs_sync_registration_snapshot on public.attendee_orgs;
create trigger attendee_orgs_sync_registration_snapshot
after insert or delete on public.attendee_orgs
for each row execute function private.sync_registration_org_snapshot();

-- Bring snapshots up to date for the backfilled registration rows.
insert into public.registration_orgs (registration_id, org_id, kind, name, code)
select er.id, o.id, o.kind, o.name, ao.code
  from public.event_registrations er
  join public.attendee_orgs ao on ao.attendee_id = er.attendee_id
  join public.organisations o on o.id = ao.org_id
on conflict (registration_id, kind, name)
do update set org_id = excluded.org_id, code = excluded.code;

create or replace function public.prepare_event_credentials(
  p_event_id uuid,
  p_items jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_registration_id uuid;
  v_credential public.registration_credentials;
  v_result jsonb := '[]'::jsonb;
  v_issued boolean;
begin
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 2000 then
    raise exception 'VALIDATION' using detail = 'credentials';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) item
     where coalesce(item->>'registration_id', '') !~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(item->>'token_hash', '') !~ '^[0-9a-f]{64}$'
        or coalesce(item->>'fallback_code_hash', '') !~ '^[0-9a-f]{64}$'
        or char_length(coalesce(item->>'print_payload', '')) not between 40 and 2048
        or item->>'token_hash' = item->>'fallback_code_hash'
  ) then
    raise exception 'VALIDATION' using detail = 'credentials';
  end if;

  if (select count(distinct item->>'registration_id') from jsonb_array_elements(p_items) item)
       <> jsonb_array_length(p_items)
     or (select count(distinct hashes.hash_value)
           from jsonb_array_elements(p_items) item
           cross join lateral unnest(array[
             item->>'token_hash', item->>'fallback_code_hash'
           ]) as hashes(hash_value))
       <> jsonb_array_length(p_items) * 2 then
    raise exception 'VALIDATION' using detail = 'credentials';
  end if;

  perform 1
    from public.event_registrations r
   where r.id in (
     select (item->>'registration_id')::uuid from jsonb_array_elements(p_items) item
   )
   order by r.id
   for update;

  if (select count(*)
        from public.event_registrations r
       where r.event_id = p_event_id
         and r.status = 'confirmed'
         and r.id in (
           select (item->>'registration_id')::uuid from jsonb_array_elements(p_items) item
         )) <> jsonb_array_length(p_items) then
    raise exception 'VALIDATION' using detail = 'registrations';
  end if;

  for v_item in select item from jsonb_array_elements(p_items) item
  loop
    v_registration_id := (v_item->>'registration_id')::uuid;
    v_credential := null;
    v_issued := false;

    select c.* into v_credential
      from public.registration_credentials c
     where c.registration_id = v_registration_id
       and c.status = 'active';

    -- Once an active credential has printable material, every later generation reuses it.
    -- Legacy hash-only credentials must be replaced once because SHA-256 cannot be reversed.
    if v_credential.id is null or v_credential.print_payload is null then
      update public.registration_credentials c
         set status = 'revoked', revoked_at = now()
       where c.registration_id = v_registration_id
         and c.status = 'active';

      insert into public.registration_credentials (
        registration_id, token_hash, fallback_code_hash, print_payload
      ) values (
        v_registration_id,
        v_item->>'token_hash',
        v_item->>'fallback_code_hash',
        v_item->>'print_payload'
      ) returning * into v_credential;
      v_issued := true;
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'registration_id', v_registration_id,
      'token_hash', v_credential.token_hash,
      'fallback_code_hash', v_credential.fallback_code_hash,
      'print_payload', v_credential.print_payload,
      'issued', v_issued
    ));
  end loop;

  return v_result;
end;
$$;

revoke execute on function public.prepare_event_credentials(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.prepare_event_credentials(uuid, jsonb) to service_role;
