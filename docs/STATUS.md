# Status: 2026-07-29

What exists and what is proven. Everything here was checked against a running
system or a real database row on the day it was written, not recalled.

**In one line:** an AI agent answers the Telnyx test line as "Robin", talks about
Akme's products, never quotes a price, and pushes every pricing question into a
written quote request that lands in its own Telegram queue. Calls are recorded,
transcribed and summarised. SMS now answers the four most common questions from
templates with no model call at all, but has still never handled a real text.

---

## Fixed today, all three found by yesterday's live calls

| Was | Now |
|---|---|
| Disclosure read by Telnyx's basic `female` TTS, then the agent answered in a different neural voice | One voice end to end (`Telnyx.Bayan.Amanda`), and the disclosure runs straight into the greeting as one sentence |
| Roughly 10s of dead air before the agent spoke | Caller context is prefetched while the disclosure plays, record and assistant-start are issued together, and the context timeout is 2500ms instead of 8000 |
| Agent opened mid-thought, "I'm not sure I caught that", before the caller spoke | `disable_greeting_interruption: true`, so line noise no longer interrupts the greeting |
| `call.recording.saved` fired twice per call | The assistant's own `recording_settings.enabled` defaults to **true** and was recording alongside ours. Now `false`, verified by read-back |
| `was_answered` false on every agent-handled call | Set when the agent takes the call, and `finishCall` never downgrades it |

## What the caller hears now

> "Hi, this is Robin from Acme USA. We supply packing materials. I'm an
> automated assistant, and this call is recorded. How can I help you today?"

Everything up to "recorded" is our own `speak` command (`OPENER`), the question is
the assistant's greeting (`GREETING`), both in lib/agent/brief.ts, same voice, no
gap.

**The introduction is in beat 1, and that is the whole point of the split.** Beat
2 cannot start until beat 1 finishes playing, `call.speak.ended` round trips, the
recording starts, the assistant boots and the context webhook answers. With the
introduction in beat 2 the caller waited about five seconds to hear a name
(Karim, 2026-08-11: "takes too long to actually say hello"). Beat 1 is the only
half that can start the instant we answer, so whatever matters most goes there.

What did NOT move is the consent ordering. California is all-party consent, so
`record_start` still fires only after beat 1 has finished, and the notice is
still inside beat 1. Folding the notice into the assistant's greeting would save
another second and would start the recording before the disclosure. That is a
compliance posture, not a latency knob.

Acme USA is said exactly once across the two beats and `tests/brief.test.ts`
asserts both the count and which half has it. This block was stale before
2026-07-29, quoting an opener neither half had ever said, so treat it as
load-bearing: if you change either string, change this quote in the same edit.

## The rule the agent runs on

**Listing is titles. Detail is a follow-up.** Asked what we stock, it says six
product names in one sentence and stops, with no sizes and no prices. Asked how
many rolls are in a case, or what size, or how many on a pallet, it answers
exactly from the brief, one product at a time. It used to be told to say the whole
spec table "freely", and it read measurements at people who had only asked what we
sell.

**It may never produce, price, or send a quote or an invoice.** Every pricing
question ends the same way: the website, an email, or a text, and a
`quote_requests` row so a human sees it. That row is the point of the phone line.

**It does not take orders.** Not item by item, not "what else", not quantities. It
cannot price any of it, so a list collected on the call is a list that dies on the
call. One description, however vague, goes straight to `text_me_the_list` and the
team works from there.

**It only says what is in the brief or what a tool just returned.** Stock levels,
lead times, delivery dates, minimums, returns and payment terms are in neither, so
it offers a person instead of an answer.

## SMS: templates first, model second

Resolution order for an inbound text:

1. Opt-out keyword, never reaches templates or the model
2. `matchTemplate()`, a hit answers outright with **zero model calls**
3. A miss goes to NEAR AI Cloud, and its draft still passes the money and
   day-commitment guards before it can auto-send

Four questions now cost nothing to answer: what we stock, our hours, how to get
a quote, and our contact details. Templates deliberately skip the guards that
run over model output, because a human wrote and reviewed them and the money
guard would otherwise block the word "quote" in the quote template itself.
Everything is GSM-7 clean, so a text stays 160 characters per segment instead of
silently dropping to 70.

## Telegram layout

Since 2026-08-04 this is the SHARED group `Akme Ops (dev)` (`-1001000000001`),
not a group of this repo's own, and the layout below is Akme's too.

| Topic | What lives in it |
|---|---|
| One per PARTY, titled `Name · +14155550142` | Every call summary and text for that person, both directions, plus Akme's email and order cards for the same human |
| `🔴 Needs You` | The one queue: a pointer line per open decision, including every quote request |
| `📈 Pipeline` | Orders moving without needing anybody |
| `🤖 Handled` | What the automation answered on its own |
| `🚨 System` | Alerts, never attached to a party |
| General | Service messages only |

One group, because a customer who calls, texts, and then emails is one
conversation. One queue, because a per-party topic answers "what did this person
say" and cannot answer "what do I owe somebody right now". A party is the
customer as a person: `crm_resolve_party` matches an email address and a phone
number onto one id, which is why a caller who already emailed lands in the
thread that already exists rather than a second one. The retired pieces are this
repo's `📋 Quote Requests` topic and the separate "Akme Phone assistant" group.

`node --env-file=.env.local scripts/surface-check.mts` asserts all of that
against the live group and exits non-zero if it stops being true.

## Proven with real services today

- `pnpm dry-run`: synthetic dual-channel recording through Supabase Storage,
  AssemblyAI `universal-3-5-pro`, NEAR AI and out to Telegram. Transcript split
  by channel, full summary, card posted, both outbox rows sent.
- `pnpm preflight`: 20/20 against live Telegram, Supabase, Telnyx, AssemblyAI
  and NEAR AI.
- `pnpm assistant:sync`: every field read back matching what was sent, including
  the five new settings above.
- `pnpm rehearse`: 9/9 scenarios against `anthropic/claude-haiku-4-5`, the same
  model that answers the phone, over Telnyx's chat completions endpoint. Scenario
  one is a replay of the real call below. It caught a live defect on its first run
  and the transcripts are in `out/rehearse/`.

## The order-taking bug, and what the rehearsal is for

The 58 second call at 20:56 on 2026-07-29, transcript quoted from the `calls` row:

> **Robin:** This is Robin. How can I help?
> **Caller:** I'd like to place an order. Hello?
> **Robin:** Hi there, what can I do for you?
> **Caller:** Hello? I'd like to place an order, please.
> **Robin:** Definitely, what do you need?
> **Caller:** I'm looking for tape and a couple other things.
> **Robin:** What kinds of tape are you after?
> **Caller:** Hot melt tape.
> **Robin:** Got it, besides the hot melt, what else?

Three asks to place an order, three open questions back, and the website, a text
and email were never mentioned. The prompt already had the routing rule: it was in
section five of eight under a heading about pricing, so ordering never reached it.
Rewritten with the routing rule as the top-level job and the item-by-item ban
stated as its own rule, the same scripted caller now gets the route in turn one and
their request on the team's queue in turn two.

The first `pnpm rehearse` run then failed that same scenario for a new reason: the
example script in the prompt said "tell me what you are after", which the model
read as licence to collect a list, so it routed correctly and then went straight
back to "what else?". A prompt is a program and that was a bug in it. The example
is now a statement rather than an invitation, followed by "STOP AND LET THEM
ANSWER".

## Still not proven

- **The opener, and it is now measured rather than suspected.** The 21:38 call
  proved the prompt half (routes on the first ask, titles-only list, and "plastic
  wrap" resolved to both films even though that phrase is not in the alias list) and
  failed the audio half: roughly 40 of 116 seconds went to "Hello? / Who is this? /
  Who is this?". `telnyx_events` says why. `call.speak.ended` +6.64s,
  `call.conversation.created` +9.40s, so there is **2.76s of dead air between the
  notice and the greeting** and the caller talks into it. `/api/agent/context`
  answered in **7ms**, so this is not our latency and the prewarm works: it is
  Telnyx booting the assistant, serially, because `record_start` and
  `ai_assistant_start` are both issued on `call.speak.ended`.
  **The fix, recommended and not built:** fold the disclosure into the assistant's
  greeting, so the boot happens before any audio instead of inside the opener. The
  care needed is consent ordering, since `record_start` currently fires after the
  disclosure and the recording deliberately excludes it. Covering the hole with
  `TELNYX_BACKGROUND_AUDIO=office` is the one-line alternative and Karim already
  rejected that room tone as murmuring.
  Note the earlier theory in this file blamed `disable_greeting_interruption`. That
  flag makes the symptom worse by discarding what is said over the greeting, but it
  is not the hole.
- **Two smaller things the same call surfaced.** Filler came back on confused turns
  ("Uh, Robin from Akme USA", "Um, we have Hand Wrap Film") despite NO FILLER,
  EVER, which is the model degrading under ambiguity rather than a missing rule. And
  the prompt has no rule for "who is this?", which went unanswered on the first ask.
- **`quote_requests` has zero rows, across every call ever placed.** The row this
  file calls the point of the phone line has never been produced live. On the 21:38
  call that is defensible (the agent offered to text the list and the caller changed
  the subject), but nothing has ever exercised the path end to end on a real call.
- **The worker can race the recording webhook.** The 21:38 call errored once with
  `has no recording_url` seconds before the webhook landed, and Telnyx's presigned
  URL carries `X-Amz-Expires=600`. pg_cron retries every 2 minutes so it self-heals
  inside that window, but a call erroring near the end of it loses its recording for
  good, because our permanent copy is made during `fetching`. Rescue by hand: POST
  `/api/worker` with `authorization: Bearer $WORKER_SECRET` until the row is
  `posted`.
- **SMS on real traffic.** `messages` still has zero rows. The template layer,
  the guards and the quote-request wiring are unit tested and have never seen a
  real text.
- **Escalation to a human.** The bridge has never run on a real call.
- **The voice.** `pnpm voice:bakeoff` renders six candidates and has still never
  been run. `Telnyx.Bayan.Amanda` is a default nobody has listened to on a phone.
- **`speak` with a premium voice.** The docs say the `<Provider>.<Model>.<VoiceId>`
  format is valid for the speak command and the assistant read-back accepts it,
  but no real call has used it yet. If Telnyx rejects it the client retries once
  with the basic voice, so the worst case is a robotic disclosure, not a dead line.

## The tunnel, and why repointing is now one command

The phone line is this laptop: `next dev` on :3000 behind a `cloudflared` quick
tunnel. That tunnel's hostname is random per start and it expires on its own.
Yesterday's died overnight and took the line with it, and four separate places
pointed at it, every one needing correction by hand.

```bash
pnpm repoint https://the-new-host.trycloudflare.com
pnpm assistant:sync
```

That updates `.env.local`, the Telnyx Call Control app, the Telnyx messaging
profile, and `switchboard_settings.public_base_url`, then reads Telnyx back to
confirm it stored what was sent. The pg_cron worker job no longer carries the URL
inline; it reads that settings row, so it needs no edit at all.

**Local DNS quirk worth knowing:** macOS `getaddrinfo` returns AAAA-only records
for `*.trycloudflare.com` on this machine, which has no IPv6 default route, so
`curl` and `fetch` fail instantly with "could not resolve host" against a tunnel
that is completely healthy. `dig` sees the A records, and so does Telnyx. The
repoint probe resolves A records directly to work around it. Do not diagnose a
dead tunnel from a failing local curl.

## Numbers

| | |
|---|---|
| Commits | 42 |
| Application code | 5,804 lines |
| Tests | 256 passing, plus 9 rehearsal scenarios against the live model |
| API routes | 7 |
| Migrations | 7, fourteen tables |
| Preflight checks | 20, all green against live services |

## Verify it yourself

```bash
pnpm preflight                        # 20 live credential checks, the gate
node ./node_modules/vitest/vitest.mjs run   # 256 tests, no network
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/next build        # 7 route handlers, 0 errors
pnpm dry-run                          # whole post-call pipeline, no phone
pnpm rehearse                         # 9 scripted callers vs the real prompt
pnpm rehearse order                   # just the scenarios matching "order"
```

Run the binaries directly. A shell wrapper on this machine collapses `pnpm`
output to a one-line summary, which reports `next build` as "1 route" when it is
actually building all seven.

## The number

Calls are on the Telnyx test number **+1 555 555 0124**. Akme's real line,
(555) 555-0158, is still on Google Voice and has not been ported. Nothing that
customers dial today touches this system.
