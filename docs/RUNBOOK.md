# Go-live checklist

Execution, not planning. Work top to bottom. Everything above the live test is
either waiting on someone else or a five-minute form.

Built and verified 2026-07-27: code, database and Telegram are done and tested.
What is missing is the phone.

## Already wired, nothing to do

- **Database**: `akme-dev` (`your-dev-project-ref`). 12 tables, RLS on with zero
  policies, so the service role key is the only way in. Private `recordings`
  bucket, 100MB cap. Scheduler functions defined, not yet scheduled.
- **Telegram**: bot `@your_phone_bot`, group "Akme Phone assistant"
  (`-1001000000002`), Topics on, bot admin with Manage Topics, privacy off.
  Verified end to end.
- **Code**: voice, SMS, Telegram routing, worker pipeline, QuickBooks mirror.
  96 tests, typecheck clean, production build green.

## Read this before planning the day

**A2P 10DLC gates OUTBOUND SMS only.** Receiving texts works immediately.
So on day one you can test inbound texts and everything about calls, but a reply
going back out as an SMS will not work until 10DLC clears, 3 to 7 business days.
That is not a bug. Do not spend an hour debugging it.

**There is no AI answering the phone yet.** What exists records, transcribes,
summarizes and routes, and rings a ring group. The realtime voice agent is not
built. A call rings your cell.

---

## 1. Start these first, they take days

- [ ] **File A2P 10DLC**, Standard brand (needs Akme's EIN). About $19.
      3 to 7 business days. Each submission costs $15 whether approved or not,
      so fill it slowly; mismatched business info is the top rejection cause.
- [ ] **Request the Google Takeout export**, Voice only. Free, hours to generate.

## 2. Credentials (10 minutes)

Fill in `.env.local`, run `pnpm preflight` after each. It names what is broken.

- [ ] `SUPABASE_SERVICE_ROLE_KEY`: Supabase dashboard, **akme-dev**, Settings > API keys
- [ ] `NEAR_AI_API_KEY`: NEAR AI Cloud, the same key Akme's email classifier uses
- [ ] `ASSEMBLYAI_API_KEY`: free tier is fine
- [ ] `FORWARD_TO_NUMBER`: your cell, E.164

## 3. Telnyx (30 to 60 minutes, plus verification wait)

- [ ] Sign up, push identity verification to **Level 2**. The slow part; start it
      before step 2 if you want to parallelize.
- [ ] Add a payment method and a small balance.
- [ ] Buy a **$1 throwaway number**. Not the Akme line. The entire point is to
      prove the system before touching a number customers call.
- [ ] Create a **Call Control application**, webhook `<public-url>/api/voice`.
- [ ] Create a **Messaging profile**, webhook `<public-url>/api/sms`.
- [ ] **Assign the number to both.** The step people skip. Owning the number and
      having an app both succeed independently while calls go nowhere. Preflight
      checks this explicitly.
- [ ] Copy into `.env.local`: API key, public key (Account > Keys, for Ed25519
      webhook verification), connection id, messaging profile id, the number.

## 4. Wire it up (20 minutes)

- [ ] `pnpm dev`, point a tunnel at port 3000, use that host in the Telnyx
      webhook fields. Deploying to Vercel instead creates a new project, which is
      a deliberate decision, not a default.
- [ ] **Seed the ring group**, or every call rings nobody and drops to voicemail:
      ```sql
      insert into responders (name, phone, ring_order) values ('Karim', '+1XXXXXXXXXX', 0);
      ```
      Same `ring_order` rings simultaneously, higher is a later wave.
- [ ] Schedule the worker:
      ```sql
      select schedule_worker('<WORKER_SECRET>', '<public-url>');
      ```
      The origin must be exact. pg_net does not follow redirects, so an apex that
      redirects to www makes the worker silently stop while looking correct.
- [ ] Confirm: `select jobname, schedule, active from cron.job order by jobname;`
      Expect `worker_tick` every 2 minutes and `prune_telnyx_events` daily. Not
      `qbo_sync`, which stays off.
- [ ] `pnpm preflight` fully green before touching anything else.

## 5. Live test (15 minutes)

- [ ] **Text the number**, a topic named after your number appears in Telegram
      with the message in it.
- [ ] **Call it**, you hear the disclosure, then your cell rings. Answer, talk
      for fifteen seconds, hang up.
- [ ] **Wait about two minutes**, a card appears in that topic with the audio,
      transcript and summary.
- [ ] **Call again, do not answer**, voicemail, card appears the same way.
- [ ] *(Blocked until 10DLC clears)* Reply in a topic, arrives as an SMS.

**Symptom to cause:** no topic on an inbound text means the messaging profile
webhook or the number assignment is wrong. No disclosure on a call means the
Call Control application is not attached to the number. Call connects but no
card means the worker: `select status, attempts, last_error from calls order by
created_at desc limit 5;`

## 6. Then two decisions

- [ ] **Build the AI receptionist, or stay with record-and-route.** Roughly 2 to
      4 days on Telnyx's native assistant at about $0.05/min. Do the live test
      first: real transcripts from step 5 tell you what it actually has to
      answer, which beats guessing.
- [ ] **Port `+1 555 555 0158`**, only after everything above passes. Unlock in
      Voice settings ($3). The account number is the 10-digit Google Voice number
      itself and the PIN is the Google Voice voicemail PIN, both counterintuitive
      and both the usual cause of rejection. About 7 business days. Google gives
      a 90-day window afterward for the original number; read that page before
      executing, not after.
