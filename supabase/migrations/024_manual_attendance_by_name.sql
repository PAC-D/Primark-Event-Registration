-- Admin scanner fallback: select a confirmed registration by name and check it in without
-- changing the existing QR credential flow.

alter table public.attendance drop constraint if exists attendance_source_check;
alter table public.attendance
  add constraint attendance_source_check check (source in ('online', 'offline', 'manual'));

create or replace function public.check_in_registration_manual(
  p_registration_id uuid,
  p_event_day_id uuid,
  p_scan_id uuid,
  p_device_id text,
  p_scanned_at_device timestamptz
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_registration public.event_registrations;
  v_day public.event_days;
  v_event public.events;
  v_attendee public.attendees;
  v_attendance_id uuid;
  v_checked_in_at timestamptz;
  v_inserted boolean := false;
  v_organisation text;
begin
  if p_registration_id is null
     or p_event_day_id is null
     or p_scan_id is null
     or char_length(btrim(coalesce(p_device_id, ''))) not between 2 and 100
     or p_scanned_at_device is null then
    raise exception 'VALIDATION' using detail = 'manual_attendance';
  end if;

  select * into v_registration
    from public.event_registrations r
   where r.id = p_registration_id;
  if v_registration.id is null then
    return jsonb_build_object('status', 'INVALID');
  end if;
  if v_registration.status <> 'confirmed' then
    return jsonb_build_object('status', 'REVOKED');
  end if;

  select * into v_day from public.event_days d where d.id = p_event_day_id;
  if v_day.id is null or v_day.event_id <> v_registration.event_id then
    return jsonb_build_object('status', 'WRONG_EVENT');
  end if;

  select * into v_event from public.events e where e.id = v_day.event_id;
  if v_event.status <> 'open'
     or (v_day.check_in_opens_at is not null and v_now < v_day.check_in_opens_at)
     or (v_day.check_in_closes_at is not null and v_now > v_day.check_in_closes_at) then
    return jsonb_build_object('status', 'OUTSIDE_CHECKIN_WINDOW');
  end if;

  select a.id, a.first_scanned_at into v_attendance_id, v_checked_in_at
    from public.attendance a
   where a.scan_id = p_scan_id
     and a.registration_id = v_registration.id
     and a.event_day_id = v_day.id;
  if v_attendance_id is null and exists (select 1 from public.attendance a where a.scan_id = p_scan_id) then
    return jsonb_build_object('status', 'INVALID');
  end if;

  if v_attendance_id is null then
    insert into public.attendance (
      registration_id, event_day_id, scanned_at_device, device_id, scan_id, source
    ) values (
      v_registration.id, v_day.id, p_scanned_at_device, btrim(p_device_id), p_scan_id, 'manual'
    )
    on conflict do nothing
    returning id, first_scanned_at into v_attendance_id, v_checked_in_at;
    v_inserted := v_attendance_id is not null;
  end if;

  if v_attendance_id is null then
    select a.id, a.first_scanned_at into v_attendance_id, v_checked_in_at
      from public.attendance a
     where a.registration_id = v_registration.id
       and a.event_day_id = v_day.id;
  end if;

  select * into v_attendee from public.attendees a where a.id = v_registration.attendee_id;
  select string_agg(ro.name, ', ' order by ro.kind, ro.name) into v_organisation
    from public.registration_orgs ro where ro.registration_id = v_registration.id;
  v_organisation := coalesce(v_organisation, v_attendee.organisation_name);

  return jsonb_build_object(
    'status', case when v_inserted then 'CHECKED_IN' else 'ALREADY_CHECKED_IN' end,
    'registration_id', v_registration.id,
    'attendee_id', v_attendee.id,
    'has_photo', v_attendee.photo_path is not null,
    'name', v_attendee.name,
    'designation', v_attendee.designation,
    'organisation', v_organisation,
    'event', v_event.name,
    'day', v_day.label,
    'checked_in_at', v_checked_in_at
  );
end;
$$;

revoke execute on function public.check_in_registration_manual(uuid, uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.check_in_registration_manual(uuid, uuid, uuid, text, timestamptz)
  to service_role;
