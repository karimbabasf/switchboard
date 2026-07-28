-- The AI agent holds the caller between the disclosure and any human. It is a
-- stage rather than a flag because the compare-and-set on `stage` is what stops
-- two concurrent webhooks from both starting an assistant, exactly as it stops
-- them both dialing a wave.
--
-- The old constraint was declared inline, so its name is whatever Postgres
-- generated. Looking it up beats hardcoding a guess that fails on a database
-- built from a slightly different path.
do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'call_flow'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%stage%';

  if cname is not null then
    execute format('alter table call_flow drop constraint %I', cname);
  end if;
end $$;

alter table call_flow add constraint call_flow_stage_check
  check (stage in ('initiated', 'answered', 'assistant', 'ringing', 'bridged', 'voicemail', 'ended'));

-- Returned by ai_assistant_start. Without it there is no way to get from a call
-- row to the conversation in Mission Control, which is the first thing anyone
-- wants when a real call goes wrong. It is also the key the later
-- call.conversation_insights.generated webhook arrives under.
alter table call_flow add column if not exists telnyx_conversation_id text;
