-- Two things the SMS side was missing, both found on 2026-08-03 while wiring
-- the text agent up to Karim's spec in docs/BEHAVIOR.md.
--
-- 1. A customer texting STOP was handled in exactly one place: a regex in
--    lib/agent/sms.ts that suppressed that turn's auto-reply. Nothing was
--    recorded, so the next inbound text from the same number started clean, and
--    nothing stopped a human tapping Send at them afterwards, or the voice
--    agent's text_me_the_list tool texting them mid-call. Carriers do enforce
--    STOP at the campaign level, and we keep our own record too, because
--    "the carrier catches it" is not a guarantee we own.
--
-- 2. There was no record of a contact having asked us to stop, so there was no
--    way to answer "did we keep texting someone who opted out" after the fact.
--
-- opted_out_at is a timestamp rather than a boolean on purpose: when they asked
-- is the question that matters in a complaint, and a boolean cannot answer it.
-- Nullable, and null means they never have.

alter table contacts
  add column if not exists opted_out_at timestamptz;

comment on column contacts.opted_out_at is
  'When this number sent an opt-out keyword. Non-null means no outbound message may be sent to them by any path, machine or human. Cleared only by an explicit START, which is why it is a timestamp and not a boolean.';

-- Partial: the overwhelming majority of contacts never opt out, and the only
-- query that matters is "is this one of the few who did".
create index if not exists contacts_opted_out_idx
  on contacts (phone)
  where opted_out_at is not null;
