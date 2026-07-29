-- The phone line's whole job is turning a call or a text into a quote request
-- that a human can price. Until now that signal existed only as prose inside a
-- summary card in one contact's topic, which means the work item and the
-- conversation were the same object: to find out what is outstanding you had to
-- open every topic and read.
--
-- This makes the request a row. The card in the index topic is a view of it, the
-- same relationship every other Telegram surface here has to Postgres, so a
-- deleted topic loses the view and never the work.

create table quote_requests (
  id uuid primary key default gen_random_uuid(),
  contact_phone text not null references contacts(phone) on delete cascade,
  -- Which channel produced it. Not cosmetic: a request taken by the agent on a
  -- call has been read back to the caller out loud, a request parsed from a text
  -- has not, so they carry different amounts of trust.
  source text not null check (source in ('call', 'sms')),
  -- What they asked for, verbatim where possible. Deliberately free text: the
  -- agent must never normalise a customer's words into a SKU it guessed.
  wants text not null,
  caller_name text,
  -- Set once a human has actually sent pricing. Nothing automated ever sets this;
  -- it is what the Done button on the card writes.
  handled_at timestamptz,
  handled_by text,
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The only query the index topic makes: what is still outstanding, oldest first,
-- because the oldest unanswered quote request is the one losing the customer.
create index quote_requests_open_idx
  on quote_requests (created_at)
  where handled_at is null;

create index quote_requests_contact_idx on quote_requests (contact_phone, created_at desc);

create trigger quote_requests_touch before update on quote_requests
  for each row execute function switchboard_touch_updated_at();

-- Telegram ids that are discovered at runtime rather than configured. The Quote
-- Requests topic is created by the bot on first use, so its thread id cannot
-- live in .env: it does not exist until the code runs, and it changes if an
-- admin deletes the topic. Same rule as contacts.telegram_topic_id, which is
-- why this is a table and not a constant.
create table switchboard_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create trigger switchboard_settings_touch before update on switchboard_settings
  for each row execute function switchboard_touch_updated_at();

alter table quote_requests        enable row level security;
alter table switchboard_settings  enable row level security;
