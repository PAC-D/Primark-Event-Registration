-- Fix an ambiguous PL/pgSQL/SQL alias in the batch hash uniqueness check from migration 007.

create or replace function public.issue_event_credentials(
  p_event_id uuid,
  p_items jsonb
) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 2000 then
    raise exception 'VALIDATION' using detail = 'credentials';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_items) item
     where coalesce(item->>'registration_id', '') !~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(item->>'token_hash', '') !~ '^[0-9a-f]{64}$'
        or coalesce(item->>'fallback_code_hash', '') !~ '^[0-9a-f]{64}$'
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

  select count(*) into v_count
    from public.event_registrations r
   where r.event_id = p_event_id
     and r.status = 'confirmed'
     and r.id in (
       select (item->>'registration_id')::uuid from jsonb_array_elements(p_items) item
     );
  if v_count <> jsonb_array_length(p_items) then
    raise exception 'VALIDATION' using detail = 'registrations';
  end if;

  update public.registration_credentials c
     set status = 'revoked', revoked_at = now()
   where c.status = 'active'
     and c.registration_id in (
       select (item->>'registration_id')::uuid from jsonb_array_elements(p_items) item
     );

  insert into public.registration_credentials (
    registration_id, token_hash, fallback_code_hash
  )
  select (item->>'registration_id')::uuid,
         item->>'token_hash',
         item->>'fallback_code_hash'
    from jsonb_array_elements(p_items) item;

  return v_count;
end;
$$;

