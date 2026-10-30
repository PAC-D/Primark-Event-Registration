-- The seminar's printed programme, as agenda rows.
--
-- Titles are verbatim: they appear on an attendee's phone and in the organisers' Excel export.
-- Breaks are stored so the attendee's list reads like the programme rather than a list with
-- holes in it; they are never selectable and never the live session. The 10:00-10:15 gap is
-- unlabelled in the programme and gets no row.
--
-- The date is a parameter rather than something this function works out for itself. The agenda
-- is a programme for one specific date, and a function that guesses the date from whatever rows
-- happen to exist is a function that silently seeds the wrong one.
--
-- A callable function rather than an inline do-block because tests/db only has a supabase-js
-- client and cannot run arbitrary SQL, which would leave the idempotency test unwritable.

create or replace function public.seed_event_agenda(
  p_event_id uuid,
  p_date date
) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_timezone text;
  v_count int;
begin
  select e.timezone into v_timezone from public.events e where e.id = p_event_id;
  if v_timezone is null then
    raise exception 'NOT_FOUND';
  end if;

  if exists (select 1 from public.event_sessions s where s.event_id = p_event_id) then
    return 0;
  end if;

  insert into public.event_sessions (event_id, position, title, kind, starts_at, ends_at)
  select p_event_id, a.position, a.title, a.kind,
         (p_date + a.local_start) at time zone v_timezone,
         case when a.local_end is null then null else (p_date + a.local_end) at time zone v_timezone end
    from (values
      (1, 'Primark Supply Chain & Bangladesh Carton Nomination Overview', 'session', time '09:30', time '10:00'),
      (2, 'Carton Nomination Programme: Strategy, Requirements & Supplier Expectations', 'session', time '10:15', time '11:15'),
      (3, 'Refreshment Break', 'break', time '11:15', time '11:45'),
      (4, 'From Nomination to Order: Garment Supplier & Packaging Supplier Integration [Carton Connect]', 'session', time '11:45', time '12:15'),
      (5, 'Nominated Packaging Supplier Capability Showcase', 'session', time '12:15', time '12:45'),
      (6, 'Ethical Team Updates', 'session', time '12:45', time '12:55'),
      (7, 'Primark Sourcing Policy and Strategy', 'session', time '12:55', time '13:05'),
      (8, 'Lunch & Networking', 'break', time '13:05', time '15:00'),
      (9, 'Booking Process & Supply Visibility', 'session', time '15:00', time '15:30'),
      (10, 'CFS, Delivery & Supply Performance Challenges', 'session', time '15:30', time '16:00'),
      (11, 'Carton Quality Performance: Common Issues & Corrective Actions', 'session', time '16:00', time '16:15'),
      (12, 'Destination QA: Performance Expectations & Feedback', 'session', time '16:15', time '16:45'),
      (13, 'Protecting Carton Performance: Storage & Handling Best Practices', 'session', time '16:45', time '17:00'),
      (14, 'Nomination Programme Q&A & Supply-Chain Alignment', 'session', time '17:00', time '17:30'),
      -- "17:30 Onwards": no end time.
      (15, 'Closing Remarks & Networking', 'break', time '17:30', null)
    ) as a(position, title, kind, local_start, local_end);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.seed_event_agenda(uuid, date) from public, anon, authenticated;
grant execute on function public.seed_event_agenda(uuid, date) to service_role;

-- Seed the existing seminar, taking its date from the earliest event day. A database with no
-- event, or an event with no day, is left alone — the guard shape migration 006 uses.
do $$
declare
  v_event record;
begin
  for v_event in
    select e.id, min(d.event_date) as event_date
      from public.events e
      join public.event_days d on d.event_id = e.id
     group by e.id
  loop
    perform public.seed_event_agenda(v_event.id, v_event.event_date);
  end loop;
end
$$;
