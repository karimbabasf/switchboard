# Go-live checklist

Execution, not planning. Work top to bottom. Everything above the live test is
either waiting on someone else or a five-minute form.

The phone now works: real calls were answered end to end on 2026-07-28. What is
left is porting the real number and the items in `docs/STATUS.md`. Read STATUS
first, it is the honest account of what is proven against what is only tested.

## Already wired, nothing to do

- **Database**: `akme-dev` (`your-dev-project-ref`), which switchboard SHARES
  with Akme. 12 of its tables are switchboard's; the rest belong to Akme's
  order pipeline, so never assume a table here is yours (see `docs/ECOSYSTEM.md`
  and the ownership list at the top of `20260727000000_init.sql`). RLS on with
  zero policies, so the service role key is the only way in. Private `recordings`
  bucket, 100MB cap.
- **Telegram**: bot `@your_phone_bot` in the SHARED group "Akme Ops
  (dev)" (`-1001000000001`), Topics on, bot admin with Manage Topics, privacy
  off. Verified end to end. Akme's `@your_dev_bot` is in the same group by
  design: one topic per customer carries their calls, texts, emails and orders
  together, and both bots keep their own webhook so a tap on either one's card
  reaches the repo that owns the action. The old separate group "Akme Phone
  assistant" (`-1001000000002`) was deleted on 2026-08-04, along with this
  repo's own `📋 Quote Requests` topic: the queue is now the shared
  `🔴 Needs You`. See `lib/crm/surface.ts` and Akme's `docs/crm-surface.md`.
- **Code**: voice, SMS, Telegram routing, worker pipeline, QuickBooks mirror.
  176 tests, typecheck clean, production build green.

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

## 2b. Prove the pipeline without a phone (5 minutes)

Do this as soon as `ASSEMBLYAI_API_KEY` is filled. It needs no Telnyx account,
so it is the right thing to run while identity verification or a payment method
is still pending.

```
pnpm dev          # one terminal
pnpm dry-run      # another
```

Builds a real dual-channel recording with `say` and `ffmpeg`, uploads it to
Supabase Storage, and drives it through the actual worker route: transcribe,
summarize, Telegram card. Prints the transcript and the summary, and a topic
for the fake caller should appear in Telegram.

That covers everything except Telnyx itself. If it passes, a failure during the
live test in step 5 is a phone problem, which is a much smaller search space.

Clean up when you have looked at the card: `pnpm dry-run --cleanup`.

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

## 5b. Turn the AI agent on (built 2026-07-28, not yet live)

The code is in and under test. Nothing below changes behaviour until
`TELNYX_ASSISTANT_ID` is set: with it empty, a call rings the ring group
exactly as it does today, which is also the rollback.

- [ ] Fill `PUBLIC_BASE_URL` with the tunnel origin (no trailing slash). The
      agent's tools and its caller-context webhook are built from it, so a stale
      value means the assistant answers and every tool call 404s.
- [ ] `AGENT_TOOL_SECRET` is already generated in `.env.local`. It is sent as
      `X-Agent-Secret` on every tool and context call and checked on the way in.
- [ ] `pnpm assistant:sync`. Prints an assistant id. Put it in `.env.local` as
      `TELNYX_ASSISTANT_ID`, then run it again: the id must not change. Running
      it twice must make exactly one assistant.
- [ ] Fire each tool from Mission Control's play button with sample data before
      any real call. A tool that 403s here is the secret or the tunnel, not the
      agent.
- [ ] `pnpm rehearse`. Nine scripted callers against the same model that answers
      the phone, for about a cent, with no phone leg. **9/9 or do not call.** It
      cannot hear the voice and cannot talk over the agent, so it is the gate you
      clear before spending a real call, never the thing that says the line is
      good. Re-run it after ANY edit to the prompt in `lib/agent/brief.ts`: that
      file is a program, and the last two defects in it were both invisible to the
      unit tests and obvious to this.
- [ ] **Call and check the recording FIRST, before judging the conversation:**
      ```
      ffprobe -v error -show_entries stream=channels,channel_layout -of default out/call.mp3
      ```
      The whole transcript design rests on the caller being on one channel and
      the agent on the other, and `speaker_labels` is off because of it. That is
      verified for a human-to-human bridge and NOT for assistant audio, which
      Telnyx generates on the leg rather than receiving from a second one. If it
      comes back mono, or both parties share a channel, stop and fix that before
      anything else.
- [ ] Then judge the call: the gap after you stop talking, whether you can cut
      it off mid-sentence, whether saying "mm-hm" derails it.
- [ ] Ask for a human. Stage should go `assistant`, `ringing`, `bridged`.
- [ ] Hang up, confirm the Telegram card still arrives with the agent's turns in
      the transcript.

**Rollback:** unset `TELNYX_ASSISTANT_ID`. The flow falls back to the ring group
by the path that is under test in `tests/voice.test.ts`.

## 6. Then two decisions

- [ ] **Point QuickBooks at the mirror.** See the note below: the blocker is not
      technical.
- [ ] **Port `+1 555 555 0158`**, only after everything above passes. Unlock in
      Voice settings ($3). The account number is the 10-digit Google Voice number
      itself and the PIN is the Google Voice voicemail PIN, both counterintuitive
      and both the usual cause of rejection. About 7 business days. Google gives
      a 90-day window afterward for the original number; read that page before
      executing, not after.
