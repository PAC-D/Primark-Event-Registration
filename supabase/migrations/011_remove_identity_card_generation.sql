-- Identity-card PDF generation has been retired. Attendance credentials remain in use.

drop function if exists public.prepare_event_credentials(uuid, jsonb);
drop function if exists public.issue_event_credentials(uuid, jsonb);

alter table public.registration_credentials
  drop column if exists print_payload;
