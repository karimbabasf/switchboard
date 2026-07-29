# Status: 2026-07-28

What exists and what is proven. Everything here was checked against a running
system or a real database row on the day it was written, not recalled.

**In one line:** an AI agent answers the Telnyx test line as "Robin", holds a
real conversation about Akme's products, and the call ends up in Telegram as a
recording, a transcript and a summary. SMS is written and unit tested but has
never handled a real text. The QuickBooks mirror is off on purpose.

---

## Proven on real phone calls

Three inbound calls hit the system today. Rows from the `calls` table:

| Started (UTC) | Duration | Recording | Transcript | Summary | Status |
|---|---|---|---|---|---|
| 2026-07-29 00:18 | 58s | yes | 475 chars | yes | posted |
| 2026-07-29 00:17 | 34s | yes | 208 chars | yes | posted |
| 2026-07-28 23:59 | 28s | no | no | no | failed |

(The timestamps are UTC. In Pacific time all three were the evening of
2026-07-28.) The failure was the second of the two bugs listed under "Found by
real calls" below, and it was fixed after that call.

Transcript from the 58 second call, verbatim, channel split with no diarization:

```
Speaker 1: No, sorry, who is this?
Speaker 2: This is Robin at Akme USA. How can I help you today?
Speaker 1: I'd like to place an order.
Speaker 2: Great, what do you need?
Speaker 1: Uh, tape. I'd like some, I'd like some packing tape,
Speaker 2: We have a couple kinds of tape. Are you looking for carton
           sealing tape or hot melt tape?
```

The summary NEAR AI produced from it, unedited:

```json
{ "headline": "Caller wants to order packing tape",
  "caller_wanted": "Place an order for packing tape",
  "sentiment": "neutral",
  "needs_followup": true,
  "action_items": [
    "Clarify which type of packing tape (carton sealing or hot melt) the caller wants",
    "Obtain quantity and any other required supplies to complete the order" ] }
```

That is the whole arc working: answer, disclosure, handoff to the agent,
conversation, hangup, recording to private Storage, AssemblyAI transcript,
NEAR AI summary, Telegram card in the caller's own forum topic.

## The call path, and what owns each step

| Step | Owner |
|---|---|
| Inbound webhook, Ed25519 verified | `app/api/voice/route.ts`, `lib/telnyx/signature.ts` |
| Answer, speak the recording plus machine disclosure | `lib/telnyx/voice.ts` |
| Start recording (dual channel mp3) | `lib/telnyx/voice.ts` |
| Hand the live leg to the AI assistant | `ai_assistant_start`, `lib/telnyx/client.ts` |
| Who is calling, injected before the agent speaks | `app/api/agent/context/route.ts` |
| The agent's four tools | `app/api/agent/tools/[tool]/route.ts`, `lib/agent/tools.ts` |
| Recording to private Storage | `lib/worker/recording.ts` |
| Transcript | `lib/worker/transcribe.ts` (AssemblyAI `universal-3-5-pro`) |
| Summary | `lib/worker/summarize.ts` (NEAR AI Cloud) |
| Telegram card, rate limited | `lib/telegram/outbox.ts`, `lib/telegram/cards.ts` |

Every slow step is done by the pg_cron worker, never in the webhook. The webhook
inserts a row and returns 200.

## Built, tested, not yet proven on real traffic

- **SMS.** The inbound classifier, the NEAR AI draft, the auto send allowlist and
  the approve or edit card are all written and unit tested. The `messages` table
  has zero rows, so no real text has ever gone through it.
- **Escalation to a human.** `was_answered` is false on all three calls, and that
  flag is only set when the human bridge connects, so the bridge has not run on a
  real call yet.
- **Voice choice.** `pnpm voice:bakeoff` renders six candidates saying the real
  greeting and a real order line. It has never been run: the current voice
  (`Telnyx.Bayan.Amanda`) is a default nobody has listened to on a phone.

## Off on purpose

**QuickBooks mirror**, `QBO_SYNC_ENABLED=false`. Intuit rotates the refresh token
on every use and the token store lives in Akme's production Supabase. A bug in
switchboard would not degrade switchboard, it would stop Akme invoicing anyone.
The client, the mirror sync and the lookups are written and tested against
fixtures. See `docs/RUNBOOK.md` section 7 for the three ways forward.

## Found by real calls, still open

1. **`was_answered` is false on agent-handled calls.** It is only set by the
   human bridge, so every call the agent handles is recorded as unanswered.
   Cosmetic today, wrong in any report built on it later.
2. **Two recordings per call.** The assistant carries its own
   `telephony_settings.recording_settings` and records alongside our
   `record_start`, so `call.recording.saved` arrives twice.
3. **The agent opens mid-thought.** The first line of the 58 second call was "I'm
   not sure I caught that", before the caller had said anything. The agent starts
   listening while the disclosure is still playing.

## Numbers

| | |
|---|---|
| Commits | 39 total, 25 of them today |
| Application code | 5,691 lines across 31 files |
| Tests | 3,022 lines across 11 files, 176 passing |
| Docs | 2,060 lines |
| API routes | 7 |
| Migrations | 6, twelve tables |
| Preflight checks | 20, all green against live services |

## Verify it yourself

```bash
pnpm preflight                      # 20 live credential checks, the gate
pnpm vitest run                     # 176 tests, no network, no credentials
npx tsc --noEmit -p tsconfig.json   # clean
npx next build                      # 7 route handlers, 0 errors
pnpm dry-run                        # whole post-call pipeline, no phone needed
```

## The number

Calls are on the Telnyx test number **+1 555 555 0124**. Akme's real line,
(555) 555-0158, is still on Google Voice and has not been ported. Nothing that
customers dial today touches this system.
