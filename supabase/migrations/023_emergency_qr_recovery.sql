-- Admin-only emergency recovery for QR URLs distributed before the printable-token migration.
-- The credential and registration UUIDs stay fixed; only the exact active token is restored.

create extension if not exists pgcrypto with schema extensions;

create table public.credential_recovery_log (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.registration_credentials (id) on delete cascade,
  registration_id uuid not null references public.event_registrations (id) on delete cascade,
  previous_token_hash text not null check (previous_token_hash ~ '^[0-9a-f]{64}$'),
  distributed_token_hash text not null check (distributed_token_hash ~ '^[0-9a-f]{64}$'),
  restored_at timestamptz not null default now()
);

alter table public.credential_recovery_log enable row level security;
revoke all on table public.credential_recovery_log from public, anon, authenticated;
grant select, insert on table public.credential_recovery_log to service_role;

create or replace function private.enforce_registration_credential_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('app.allow_credential_restore', true) = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if exists (
      select 1
        from public.registration_credentials c
       where c.registration_id = new.registration_id
    ) then
      raise exception 'IMMUTABLE_CREDENTIAL';
    end if;
    return new;
  end if;

  if new.registration_id is distinct from old.registration_id
     or new.token_hash is distinct from old.token_hash
     or new.fallback_code_hash is distinct from old.fallback_code_hash
     or (old.print_token is not null and new.print_token is distinct from old.print_token)
     or (old.fallback_code is not null and new.fallback_code is distinct from old.fallback_code) then
    raise exception 'IMMUTABLE_CREDENTIAL';
  end if;

  return new;
end;
$$;

create or replace function public.restore_distributed_credential(
  p_current_token_hash text,
  p_distributed_token_hash text,
  p_distributed_token text
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_credential public.registration_credentials;
begin
  if coalesce(p_current_token_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_distributed_token_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_distributed_token, '') !~ '^ER1[.][A-Za-z0-9_-]{32}$' then
    raise exception 'VALIDATION' using detail = 'credential';
  end if;
  if encode(extensions.digest(p_distributed_token, 'sha256'), 'hex')
       <> p_distributed_token_hash then
    raise exception 'VALIDATION' using detail = 'credential';
  end if;
  if p_current_token_hash = p_distributed_token_hash then
    raise exception 'SAME_CREDENTIAL';
  end if;

  select c.* into v_credential
    from public.registration_credentials c
   where c.token_hash = p_current_token_hash
     and c.status = 'active'
   for update;
  if v_credential.id is null then
    raise exception 'NOT_FOUND';
  end if;

  if exists (
    select 1
      from public.registration_credentials c
     where c.token_hash = p_distributed_token_hash
       and c.id <> v_credential.id
  ) then
    raise exception 'CREDENTIAL_COLLISION';
  end if;

  perform set_config('app.allow_credential_restore', 'on', true);
  update public.registration_credentials
     set token_hash = p_distributed_token_hash,
         print_token = p_distributed_token
   where id = v_credential.id;
  perform set_config('app.allow_credential_restore', 'off', true);

  insert into public.credential_recovery_log (
    credential_id, registration_id, previous_token_hash, distributed_token_hash
  ) values (
    v_credential.id, v_credential.registration_id,
    p_current_token_hash, p_distributed_token_hash
  );

  return v_credential.registration_id;
end;
$$;

revoke execute on function public.restore_distributed_credential(text, text, text)
  from public, anon, authenticated;
grant execute on function public.restore_distributed_credential(text, text, text)
  to service_role;
