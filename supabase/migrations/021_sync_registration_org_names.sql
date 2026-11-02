-- Keep QR verification snapshots aligned when an organisation is renamed.
-- Snapshots whose organisation was deleted retain their historical name because
-- their org_id is set to null by the foreign key.

create or replace function private.sync_registration_org_name()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A previous rename may already have produced both the old and new snapshot
  -- names. Remove every stale linked name before recreating the current row.
  delete from public.registration_orgs
   where org_id = new.id
     and name <> new.name;

  insert into public.registration_orgs (registration_id, org_id, kind, name, code)
  select er.id, new.id, new.kind, new.name, ao.code
    from public.event_registrations er
    join public.attendee_orgs ao on ao.attendee_id = er.attendee_id
   where ao.org_id = new.id
  on conflict (registration_id, kind, name)
  do update set org_id = excluded.org_id, code = excluded.code;

  return new;
end;
$$;

drop trigger if exists organisations_sync_registration_snapshot_name on public.organisations;
create trigger organisations_sync_registration_snapshot_name
after update of name on public.organisations
for each row
when (old.name is distinct from new.name)
execute function private.sync_registration_org_name();

-- Repair stale linked snapshots created before the trigger existed.
delete from public.registration_orgs ro
using public.organisations o
where ro.org_id = o.id
  and ro.name <> o.name;

insert into public.registration_orgs (registration_id, org_id, kind, name, code)
select er.id, o.id, o.kind, o.name, ao.code
  from public.event_registrations er
  join public.attendee_orgs ao on ao.attendee_id = er.attendee_id
  join public.organisations o on o.id = ao.org_id
on conflict (registration_id, kind, name)
do update set org_id = excluded.org_id, code = excluded.code;
