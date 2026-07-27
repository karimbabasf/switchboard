-- Schedule the post-call worker tick.
--
-- Same shape and the same reasoning as Akme's schedule_inbound: the secret
-- arrives as a parameter so it never lands in a SQL editor, a transcript, or
-- shell history, and re-running is safe because the job unschedules first.
--
-- Every 2 minutes, comfortably inside the 10-minute Telnyx presigned
-- recording URL window: a row can sit through several missed or slow ticks
-- before lib/worker/recording.ts gives up on it as expired.
--
-- Overlap is expected and safe. pg_cron does not wait for one invocation to
-- finish before firing the next, and lib/worker/run.ts claims rows with a
-- conditional UPDATE keyed on (id, status, attempts), so two overlapping
-- ticks racing on the same row never both win the claim.
--
-- p_origin MUST be the exact host the app serves on. pg_net does not follow
-- redirects, so an apex that 308s to www would make the worker silently stop
-- while looking correctly configured.

create or replace function public.schedule_worker(p_secret text, p_origin text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_origin text := rtrim(p_origin, '/');
  v_url    text := v_origin || '/api/worker';
begin
  if p_secret is null or length(p_secret) < 16 then
    raise exception 'refusing to schedule with a weak or empty worker secret';
  end if;

  begin
    perform cron.unschedule('worker_tick');
  exception when others then
    null;  -- not scheduled yet, the normal first run
  end;

  perform cron.schedule(
    'worker_tick',
    '*/2 * * * *',
    format(
      $f$select net.http_post(
           url := %L,
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'Authorization', 'Bearer ' || %L
           ),
           body := '{}'::jsonb,
           timeout_milliseconds := 240000
         );$f$,
      v_url, p_secret
    )
  );

  return v_url;
end;
$$;

revoke all on function public.schedule_worker(text, text) from public, anon, authenticated;
grant execute on function public.schedule_worker(text, text) to service_role;
