-- Voice flow state. Everything here exists because a Telnyx webhook is not a
-- reliable, ordered, once-only message: Telnyx retries aggressively on any
-- non-2xx, gives no ordering guarantee, and states plainly that a webhook may be
-- delivered more than once. So the call state machine cannot live in memory or
-- infer anything from arrival order, and every transition has to be replayable.
--
-- OWNERSHIP: switchboard owns these three tables. calls, contacts and responders
-- are created in 20260727000000_init.sql and are not altered here.

-- Every webhook Telnyx has ever handed us, claimed exactly once.
--
-- The claim IS the primary key insert: whoever wins the insert owns the event and
-- everybody else is a duplicate that must no-op. A handler that throws deletes its
-- own row so the next Telnyx retry can re-claim, which is why this is a claim log
-- and not an append-only audit log.
--
-- occurred_at is Telnyx's timestamp for when the event happened, and is the only
-- ordering signal that means anything. Nothing in this system may order by
-- received_at.
create table telnyx_events (
  id              text primary key,                  -- webhook data.id
  event_type      text not null,                     -- webhook data.event_type
  call_control_id text,
  occurred_at     timestamptz not null,              -- webhook data.occurred_at
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,                       -- null means claimed, still running
  error           text
);

create index telnyx_events_call_idx     on telnyx_events (call_control_id, occurred_at);
-- For pruning. This table grows one row per webhook forever and nothing in the
-- app deletes from it, so it needs a scheduled sweep of rows older than a month.
create index telnyx_events_received_idx on telnyx_events (received_at);

-- One row per inbound call, holding the position in the flow.
--
-- Separate from calls because calls is the record of what happened (for the
-- Telegram card and the transcript pipeline) while this is the machine's cursor.
-- Every advance is a compare-and-set on `stage`, so two concurrent webhooks
-- racing to advance the same call cannot both win, and a replayed webhook whose
-- transition already happened updates zero rows and does nothing.
create table call_flow (
  call_control_id   text primary key,                -- the inbound leg (leg A)
  call_id           uuid not null references calls(id) on delete cascade,
  stage             text not null default 'initiated'
                      check (stage in ('initiated', 'answered', 'ringing', 'bridged', 'voicemail', 'ended')),
  wave              integer,                         -- responders.ring_order currently ringing
  -- Recording starts only after the disclosure finishes, so a caller who hangs up
  -- during the disclosure leaves no recording at all. Without this flag the hangup
  -- handler cannot tell that case from "the recording webhook has not landed yet",
  -- because call.recording.saved arrives AFTER call.hangup.
  recording_started boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index call_flow_call_idx on call_flow (call_id);

-- One row per responder leg we dial. Rows sharing a wave were dialed
-- simultaneously; a higher wave is a later attempt.
create table call_legs (
  call_control_id text primary key,                  -- Telnyx id for the responder leg
  call_id         uuid not null references calls(id) on delete cascade,
  responder_id    uuid references responders(id) on delete set null,
  phone           text not null,
  wave            integer not null,                  -- the responders.ring_order that produced it
  status          text not null default 'ringing'
                    check (status in ('ringing', 'answered', 'dead')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index call_legs_wave_idx on call_legs (call_id, wave) where status = 'ringing';

-- First leg to answer wins, enforced by the database rather than by reading then
-- writing. Two responders picking up in the same instant is the normal case for a
-- simulring wave, and application-level "check if anyone answered yet" loses that
-- race. The second UPDATE to 'answered' violates this index, and that violation is
-- the losing leg's signal to hang itself up.
create unique index call_legs_one_winner_idx on call_legs (call_id) where status = 'answered';

create trigger call_flow_touch before update on call_flow
  for each row execute function switchboard_touch_updated_at();
create trigger call_legs_touch before update on call_legs
  for each row execute function switchboard_touch_updated_at();

alter table telnyx_events enable row level security;
alter table call_flow     enable row level security;
alter table call_legs     enable row level security;
