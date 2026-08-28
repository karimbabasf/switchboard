-- The phone line may take an order now.
--
-- Two tables, and they are deliberately not one. A QUOTE is a price said out
-- loud that nobody has agreed to yet; a DRAFT is an order somebody asked us to
-- text them. Collapsing them would mean either a row that is a draft before the
-- caller said yes, or a link token that inherits a ten minute life, and both of
-- those are wrong in a way a customer finds out about.
--
-- Neither table holds a price. The catalogue lives in lib/agent/brief.ts and
-- mirrors Akme's lib/catalog.ts, and `pnpm preflight` fails if the two drift.
-- What is stored here is what somebody was quoted, in integer cents, so a
-- dispute three days later can be answered with the number they actually heard.
--
-- RLS is enabled with ZERO policies on both, like every other table in this
-- repo. That is not a lockout of Akme: this is the shared akme-dev database
-- and both apps connect with a service role key, which bypasses RLS. It is a
-- lockout of the anon key, so no browser can read a customer's order off a
-- token it guessed.

-- ---------------------------------------------------------------------------
-- Quotes: ten minutes, single use
-- ---------------------------------------------------------------------------
--
-- `price_order` writes one and says the subtotal. `send_order_link` is the only
-- thing that spends it, with a conditional UPDATE on `used_at is null`, which is
-- the same compare-and-set the call pipeline claims rows with. Two racing tool
-- calls therefore produce exactly one text.
--
-- Bound to `caller_phone` on purpose. Telnyx sends no call identity with a tool
-- call, so the number is whatever the model wrote; price_order checks it against
-- the live call before writing this row, and this column is what stops a token
-- proven on one call being spent on another.
create table phone_order_quotes (
  token           text primary key,
  -- Telnyx call control id. Null only if the call ended between the check and
  -- the write, which is a quote nobody will spend.
  call_id         text,
  caller_phone    text not null,
  -- [{ product, units }]. Product ids are validated against the six id enum in
  -- lib/orders/catalog.ts BEFORE anything is written, so nothing a caller said
  -- reaches this column in any form.
  lines           jsonb not null,
  fulfilment      text not null check (fulfilment in ('delivery', 'willcall')),
  -- Integer cents, always. Never numeric, never a float: 24.42 * 5 is
  -- 122.10000000000001 in floating point, and this is a number somebody is held
  -- to out loud.
  subtotal_cents  integer not null check (subtotal_cents >= 0),
  -- [{ product, wanted, available }] at the moment of quoting. Kept because it
  -- is what the caller was told, not what the shelf says now.
  short_stock     jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  -- When it was spent. Non-null means the link is already out; a second attempt
  -- is told so rather than sending a second text.
  used_at         timestamptz
);

-- The only sweep this table will ever want: quotes nobody spent, so they can be
-- pruned. Partial, because the spent ones are the record and stay.
create index phone_order_quotes_unspent_idx
  on phone_order_quotes (expires_at)
  where used_at is null;

-- ---------------------------------------------------------------------------
-- Drafts: forty-eight hours, one nudge at twenty-four
-- ---------------------------------------------------------------------------
--
-- Owned by this repo. Akme READS it to render `/order/<token>` pre filled, and
-- writes only `confirmed_at` and `order_reference` when the customer submits.
-- Every other column is written here and nowhere else.
create table phone_order_drafts (
  id              uuid primary key default gen_random_uuid(),
  -- 32 random bytes, url safe. Unguessable, because it is the only thing
  -- standing between a stranger and somebody's order details.
  token           text unique not null,
  call_id         text,
  -- E.164, and it is the number that CALLED US, checked against the live call
  -- rather than taken from the model's argument. It is also the number the link
  -- was texted to, so it is the number Akme recognises the visitor by.
  caller_phone    text not null,
  lines           jsonb not null,
  fulfilment      text not null check (fulfilment in ('delivery', 'willcall')),
  subtotal_cents  integer not null check (subtotal_cents >= 0),
  -- Karim's rule 9: the threshold FLAGS THE RECORD AND CHANGES NOTHING THE
  -- CALLER HEARS. There is no five thousand dollar behaviour on the call, no
  -- approval step and no different sentence. This column exists for the Telegram
  -- card that does not exist yet.
  large_order     boolean not null default false,
  created_at      timestamptz not null default now(),
  -- created_at + 48 hours. Past this the page renders a dead link and never a
  -- form: a pre filled order at a price nobody has stood behind for two days is
  -- a promise we did not make.
  expires_at      timestamptz not null,
  -- The single 24 hour SMS. Stamped BEFORE the send, because the rule is one
  -- nudge and never two, so a stamped nudge that failed to go out is the failure
  -- we choose over a customer texted twice.
  nudged_at       timestamptz,
  -- Akme writes these two, and only these two.
  confirmed_at    timestamptz,
  order_reference text
);

comment on column phone_order_drafts.large_order is
  'subtotal_cents >= 500000. Flags the record only. Nothing on the call reads it.';

comment on column phone_order_drafts.confirmed_at is
  'Written by Akme when the customer submits the form. Switchboard never sets it.';

comment on column phone_order_drafts.order_reference is
  'Written by Akme alongside confirmed_at. Switchboard never sets it.';

-- The nudge sweep, run by /api/worker every two minutes: unconfirmed, unnudged,
-- oldest first. Partial so the sweep never touches the finished ones, which are
-- the majority the moment this table has any history.
create index phone_order_drafts_nudge_idx
  on phone_order_drafts (created_at)
  where confirmed_at is null and nudged_at is null;

-- What a customer's thread wants: their drafts, newest first.
create index phone_order_drafts_caller_idx
  on phone_order_drafts (caller_phone, created_at desc);

alter table phone_order_quotes enable row level security;
alter table phone_order_drafts enable row level security;
