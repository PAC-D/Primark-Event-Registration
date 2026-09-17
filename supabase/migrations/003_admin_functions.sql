-- Admin changes: edit, delete, approve and merge. Each call is one transaction.

create or replace function private.delete_orphan_pending()
returns void
language sql
set search_path = ''
as $$
  delete from public.organisations o
   where o.status = 'pending'
     and not exists (select 1 from public.attendee_orgs ao where ao.org_id = o.id);
$$;

create or replace function public.update_attendee(p_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_orgs jsonb;
begin
  perform 1 from public.attendees where id = p_id for update;
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

  delete from public.attendee_orgs where attendee_id = p_id;
  insert into public.attendee_orgs (attendee_id, org_id, code)
  select p_id, (e->>'org_id')::bigint, e->>'code'
    from jsonb_array_elements(v_orgs) as e;

  perform private.delete_orphan_pending();
end;
$$;

create or replace function public.delete_attendee(p_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.attendees where id = p_id;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  perform private.delete_orphan_pending();
end;
$$;

create or replace function public.approve_org(p_id bigint)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.organisations
     set status = 'approved'
   where id = p_id
     and status = 'pending';
  if not found then
    raise exception 'NOT_FOUND';
  end if;
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
begin
  -- Same lock order as prepare_registration (by id) to avoid deadlocks.
  perform 1 from public.organisations where id in (p_source, p_target) order by id for update;

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

  if v_count > 2 and not p_allow_over_limit then
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

revoke execute on function private.delete_orphan_pending() from public, anon, authenticated;
grant execute on function private.delete_orphan_pending() to service_role;
revoke execute on function public.update_attendee(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.update_attendee(uuid, jsonb) to service_role;
revoke execute on function public.delete_attendee(uuid) from public, anon, authenticated;
grant execute on function public.delete_attendee(uuid) to service_role;
revoke execute on function public.approve_org(bigint) from public, anon, authenticated;
grant execute on function public.approve_org(bigint) to service_role;
revoke execute on function public.merge_org(bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function public.merge_org(bigint, bigint, boolean) to service_role;
