# switchboard

Akme's phone line. An AI answers, handles the questions whose answers already
live in QuickBooks, and escalates to a human on request or on low confidence.
Every call and text is recorded, transcribed and routed into a Telegram
supergroup, one forum topic per contact, two-way.

Calls and SMS run on Telnyx. State lives in the shared `akme-dev` Supabase
database. Recordings go to private Supabase Storage, transcripts to AssemblyAI,
summaries to Claude Haiku 4.5.

## Run it

```bash
pnpm install
cp .env.example .env.local   # then fill it in
pnpm preflight               # confirms every credential is live, not just present
pnpm dev
```

`pnpm preflight` is the gate. It makes a real call against every service and
names whatever is broken instead of failing as one blob. Do not start debugging
behaviour until it is green.

Webhooks need a public URL, so point a tunnel at port 3000 and use that host in
the Telnyx portal. See `docs/RUNBOOK.md` for the full go-live sequence.

## Test it

```bash
pnpm vitest run                     # whole suite
pnpm vitest run tests/voice.test.ts # one file
npx tsc --noEmit -p tsconfig.json   # typecheck
```

Everything external is mocked, so the suite needs no credentials and makes no
network calls.

## Layout

| Path | What |
|---|---|
| `app/api/voice` | Telnyx Call Control webhook, the inbound call state machine |
| `app/api/sms` | Telnyx messaging webhook, inbound SMS and delivery receipts |
| `app/api/telegram` | Bot webhook: replies become outbound SMS, button callbacks |
| `app/api/worker` | Post-call pipeline tick, driven by pg_cron every 2 minutes |
| `app/api/qbo-sync` | QuickBooks mirror pull, off unless `QBO_SYNC_ENABLED=true` |
| `lib/telnyx` | Call Control commands, SMS, Ed25519 webhook verification |
| `lib/telegram` | Topic resolution, the rate-limited outbox drain, card rendering |
| `lib/worker` | Recording to storage, transcription, summarization |
| `lib/qbo` | Mirror sync and the millisecond lookups the voice agent uses |

## Two things that will bite

**The QuickBooks sync is off by default and that is deliberate.** Intuit rotates
the refresh token on every use, so the token store is shared with Akme
production. A bug here does not degrade switchboard, it stops Akme being able
to invoice anyone. Turn it on knowingly or not at all.

**Nothing posts to Telegram directly.** The Bot API caps a group at roughly 20
messages per minute shared across every topic, and one finished call card is
already three messages. Everything goes through the `outbox` table and drains
with backoff.
