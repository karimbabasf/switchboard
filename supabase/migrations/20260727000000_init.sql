-- switchboard: calls and SMS on one number, routed into Telegram forum topics.
-- Supabase is the book of record. Telegram topics are a view that can be deleted
-- by any group admin with no recovery path, so nothing lives only in Telegram.

create extension if not exists pgcrypto;

-- One row per phone number we have ever talked to.
-- telegram_topic_id is nullable and REPLACEABLE: a deleted topic is detected on
-- send failure, the id is cleared, and the next send recreates it.
create table contacts (
  phone             text primary key,               -- E.164, e.g. +14155550123
  display_name      text,
  telegram_topic_id bigint unique,
  topic_created_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table messages (
  id                 uuid primary key default gen_random_uuid(),
  contact_phone      text not null references contacts(phone) on delete cascade,
  direction          text not null check (direction in ('inbound', 'outbound')),
  body               text,
  media              jsonb not null default '[]'::jsonb,
  provider_id        text unique,                   -- Telnyx message id, null until sent
  provider_status    text,                          -- queued/sent/delivered/failed
  telegram_message_id bigint,
  created_at         timestamptz not null default now()
);

create index messages_contact_time_idx on messages (contact_phone, created_at desc);

create table calls (
  id               uuid primary key default gen_random_uuid(),
  contact_phone    text not null references contacts(phone) on delete cascade,
  direction        text not null check (direction in ('inbound', 'outbound')),
  provider_call_id text unique,
  started_at       timestamptz not null default now(),
  answered_at      timestamptz,
  ended_at         timestamptz,
  duration_sec     integer,
  was_answered     boolean not null default false,  -- false means it fell through to voicemail
  recording_url    text,                            -- provider-side URL, expires
  storage_path     text,                            -- our copy in Supabase Storage, permanent
  transcript       text,
  summary          jsonb,
  -- Pipeline state. The webhook only ever inserts with status 'new' and returns 200;
  -- the pg_cron worker does every slow step and is safe to retry.
  status           text not null default 'new'
                     check (status in ('new', 'fetching', 'transcribing', 'summarizing', 'posted', 'failed')),
  attempts         integer not null default 0,
  last_error       text,
  telegram_message_id bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index calls_pending_idx on calls (status, created_at) where status not in ('posted', 'failed');

-- Telegram send queue. Exists because the Bot API caps a group at ~20 messages per
-- minute SHARED ACROSS ALL TOPICS, and one finished call is already 3 messages.
-- Nothing posts to Telegram directly; everything is drained from here with backoff.
create table outbox (
  id              uuid primary key default gen_random_uuid(),
  thread_id       bigint,                           -- null targets the General topic
  kind            text not null check (kind in ('text', 'audio', 'document', 'edit')),
  payload         jsonb not null,
  status          text not null default 'pending'
                    check (status in ('pending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  sent_message_id bigint,
  created_at      timestamptz not null default now()
);

create index outbox_drain_idx on outbox (next_attempt_at) where status = 'pending';

-- Short-lived payloads for inline keyboard buttons. Telegram caps callback_data at
-- 64 BYTES, so buttons carry this row's id and never the data itself.
create table callback_actions (
  id         uuid primary key default gen_random_uuid(),
  action     text not null,
  params     jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default now() + interval '30 days',
  created_at timestamptz not null default now()
);

-- Who a call can ring, and in what order. Replaces Google Voice "linked numbers"
-- and goes past it: same ring_order means those legs ring simultaneously, higher
-- ring_order means a later wave, so simulring and cascade are the same table.
-- Also the escalation target when the voice agent hands a live call to a human.
create table responders (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  phone            text not null unique,           -- E.164
  ring_order       integer not null default 0,
  active           boolean not null default true,
  telegram_user_id bigint,                         -- so a Telegram reply is attributable
  created_at       timestamptz not null default now()
);

create index responders_ring_idx on responders (ring_order) where active;

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger contacts_touch before update on contacts
  for each row execute function touch_updated_at();
create trigger calls_touch before update on calls
  for each row execute function touch_updated_at();

-- Every table is service-role only. There is no client app and no anon access:
-- RLS on with zero policies denies everything except the service role key.
alter table contacts         enable row level security;
alter table messages         enable row level security;
alter table calls            enable row level security;
alter table outbox           enable row level security;
alter table callback_actions enable row level security;
alter table responders       enable row level security;
