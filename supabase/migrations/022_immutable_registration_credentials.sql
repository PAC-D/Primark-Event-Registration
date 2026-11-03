-- A registration's QR identity is permanent. Participant edits and later downloads must never
-- rotate it, overwrite it, or create a second credential. Status may still be revoked/reactivated.

create or replace function private.enforce_registration_credential_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
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

drop trigger if exists registration_credentials_immutable
  on public.registration_credentials;
create trigger registration_credentials_immutable
before insert or update on public.registration_credentials
for each row execute function private.enforce_registration_credential_immutability();
