# Go-live runbook

Everything below is what is left after the 2026-07-27 build session. The code,
the database and the Telegram side are done and tested. This is the phone.

## Already wired, nothing to do

- **Database**: `akme-dev` (`your-dev-project-ref`). 9 tables, RLS on, zero
  policies, so the service role key is the only way in. Private `recordings`
  storage bucket, 100MB cap.
- **Telegram**: bot `@your_phone_bot`, group "Akme Phone assistant"
  (`-1001000000002`), Topics on, bot admin with Manage Topics, privacy mode off.
  Verified end to end: topic created, message delivered into it, cleaned up.
- **Code**: voice, SMS, Telegram routing, worker pipeline, QuickBooks mirror.

## Step 1: credentials still missing

Fill these in `.env.local`, then run `pnpm preflight` after each one. It names
whatever is broken instead of failing as one blob.

| Var | Where |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard, akme-dev, Project Settings > API keys |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `ASSEMBLYAI_API_KEY` | assemblyai.com, free tier is fine for testing |
| `FORWARD_TO_NUMBER` | your cell, E.164, e.g. +1415... |

## Step 2: Telnyx

1. Sign up, complete identity verification to **Level 2**. This gates buying
   numbers and sending SMS and is the slow part.
2. Add a payment method and a small balance.
3. Buy a **throwaway** local number, about $1/mo. Do not use the real Akme
   number yet. The whole point is to prove the system before touching a line
   customers actually call.
4. Create a **Call Control application**. Set its webhook URL to
   `<public-url>/api/voice`. Note the connection id.
5. Create a **Messaging profile**. Set its webhook URL to `<public-url>/api/sms`.
6. Assign the number to both the Call Control application and the messaging
   profile. This is the step people miss: owning the number and having an app
   both succeed independently while inbound calls go nowhere. `pnpm preflight`
   checks it explicitly.
7. Copy the API key, the public key (Account > Keys, used for Ed25519 webhook
   verification), the connection id, the messaging profile id and the number
   into `.env.local`.

`pnpm preflight` should now be fully green.

## Step 3: a public URL

Webhooks need one. Two options:

- **Tunnel to localhost** (recommended for the first live test): run the app
  with `pnpm dev`, point a tunnel at port 3000, and use that URL in the Telnyx
  webhook fields. Fastest iteration, and it creates nothing permanent.
- **Deploy to Vercel**: this creates a new Vercel project, which is Karim's call
  to make in the moment, not something to do automatically.

## Step 4: seed the ring group

Insert yourself, and anyone else who should be able to pick up:

```sql
insert into responders (name, phone, ring_order) values
  ('Karim', '+1XXXXXXXXXX', 0);
```

Same `ring_order` rings simultaneously. A higher `ring_order` is a later wave
that only starts if the earlier one did not answer.

## Step 5: schedule the background jobs

Two pg_cron jobs ship as migrations. Apply them and confirm they are scheduled:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Expect the worker every 2 minutes (well inside the 10-minute expiry on Telnyx
recording links) and the QuickBooks sync every 15.

## Step 6: the live test, in order

1. **Text the throwaway number.** A topic named after your number appears in the
   Telegram group with the message in it.
2. **Reply in that topic.** The reply arrives as an SMS on your phone.
3. **Call the throwaway number.** You hear the recording disclosure, then your
   cell rings. Answer it, talk for fifteen seconds, hang up.
4. **Wait about two minutes.** A call card appears in that contact's topic with
   the audio, transcript and summary.
5. **Call again and do not answer.** It falls through to voicemail, and the card
   shows up the same way.

If step 1 fails, the messaging profile webhook or the number assignment is
wrong. If step 3 plays no disclosure, the Call Control application is not
attached to the number. If the call connects but no card appears, check the
worker: `select status, attempts, last_error from calls order by created_at desc`.

## Step 7: only once all of that passes

Port the real number, `+1 555 555 0158`. See docs/research/research-gvoice.md for
the port-out specifics; the two counterintuitive ones are that the account
number is the 10-digit Google Voice number itself and the PIN is the Google
Voice voicemail PIN.

A2P 10DLC registration (Standard brand, needs Akme's EIN) gates outbound SMS on
any US number, including the throwaway. File it early, it takes 3 to 7 business
days and each submission costs $15 whether or not it is approved.
