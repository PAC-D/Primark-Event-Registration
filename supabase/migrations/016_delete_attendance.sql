-- A check-in is one scan and one row, and until now nothing could remove it: a mis-scan, a test
-- scan during setup, or the wrong card handed over left a person marked Present for good.
-- Deleting the row returns them to Pending and lets the scanner record them again.
--
-- Questions they have already asked are deliberately not touched. They did ask them.

create or replace function public.delete_attendance(
  p_registration_id uuid,
  p_event_day_id uuid
) returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.attendance
   where registration_id = p_registration_id
     and event_day_id = p_event_day_id;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
end;
$$;

revoke execute on function public.delete_attendance(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_attendance(uuid, uuid) to service_role;
