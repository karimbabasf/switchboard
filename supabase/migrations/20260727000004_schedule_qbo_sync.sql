-- Schedule the QuickBooks mirror sync.
--
-- Same shape and the same reasoning as Akme's schedule_inbound: the secret
-- arrives as a parameter so it never lands in a SQL editor, a transcript, or
-- shell history, and re-running is safe because the job unschedules first.
--
-- Every 15 minutes: the mirror exists so the voice agent reads in milliseconds
-- instead of a 1-3 second live QBO round trip, and a 15 minute staleness
-- window is the trade this repo is making for that. Tighten it later if a
-- caller ever hits a price or balance that changed inside the window.
--
-- p_origin MUST be the exact host the app serves on. pg_net does not follow
-- redirects, so an apex that 308s to www would make every sync silently
-- vanish while looking correctly configured.

create or replace function public.schedule_qbo_sync(p_secret text, p_origin text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_origin text := rtrim(p_origin, '/');
  v_url    text := v_origin || '/api/qbo-sync';
begin
  if p_secret is null or length(p_secret) < 16 then
    raise exception 'refusing to schedule with a weak or empty worker secret';
  end if;

  begin
    perform cron.unschedule('qbo_sync');
  exception when others then
    null;  -- not scheduled yet, the normal first run
  end;

  perform cron.schedule(
    'qbo_sync',
    '*/15 * * * *',
    format(
      $f$select net.http_post(
           url := %L,
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'Authorization', 'Bearer ' || %L
           ),
           body := '{}'::jsonb,
           timeout_milliseconds := 120000
         );$f$,
      v_url, p_secret
    )
  );

  return v_url;
end;
$$;

revoke all on function public.schedule_qbo_sync(text, text) from public, anon, authenticated;
grant execute on function public.schedule_qbo_sync(text, text) to service_role;
