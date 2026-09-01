-- The daily sweep that keeps telnyx_events from growing forever.
--
-- WRITTEN DOWN LATE, ON PURPOSE. This function has been running in the dev
-- database since 2026-07-27 as a hand-made object with no file behind it, and
-- the gap only showed up on 2026-09-01 when production was built from the
-- migrations and came out one function short of dev. A schedule that exists in
-- one database and in nobody's repository is invisible until something is
-- rebuilt from source, which is exactly when it is most expensive to notice.
--
-- The cron job that calls it is NOT created here. Scheduling is per environment,
-- because the schedule belongs to the database that owns the events, and
-- `schedule_worker` is the pattern the rest of this repo follows: a callable
-- function that takes the origin, never a job baked into a migration.
create or replace function public.prune_telnyx_events()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare v_deleted integer;
begin
  delete from public.telnyx_events where received_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

revoke all on function public.prune_telnyx_events() from public, anon, authenticated;
grant execute on function public.prune_telnyx_events() to service_role;
