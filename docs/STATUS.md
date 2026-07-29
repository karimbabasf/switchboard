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

> "Just so you know, this call is recorded and you're speaking with an automated
> assistant. Hi, this is Robin from Akme USA. How can I help you today?"

First sentence is our own `speak` command (`RECORDING_DISCLOSURE`), second is the
assistant's greeting (`GREETING` in lib/agent/brief.ts), same voice, no gap.

The split is deliberate and tested: the notice half carries the recording and
machine disclosures and **nothing else**, and the company name lives in the
greeting so a caller hears a person introduce themselves and where they work.
Akme USA is said exactly once across the two, and `tests/brief.test.ts` asserts
both the count and which half has it. This block was stale before 2026-07-29,
quoting an opener neither half had ever said, so treat it as load-bearing: if you
change either string, change this quote in the same edit.

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

| Topic | What lives in it |
|---|---|
| One per contact, titled `Name · (555) 123-4567` | Every call summary and every text for that person, both directions |
| `📋 Quote Requests` | One card per quote request: who, number, channel, what they asked for, and a Done button |
| General | System messages only |

One group, because a customer who calls and then texts is one conversation. The
index topic exists because a per-contact topic answers "what did this person
say" and nobody can work a queue out of that.

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

- **The new opener and the new prompt, on a real call.** Everything above was
  proven in text, and `pnpm rehearse` cannot hear the voice, cannot be talked over,
  and never touches Telnyx voice. It is the cheap gate, not the verdict. The next
  real call to +1 555 555 0124 is what says whether the two-beat opener sounds like
  one person and whether the routing holds when a caller rambles.
- **Whether the caller's first words survive the greeting.** On the 20:56 call the
  caller said "I'd like to place an order" and then "Hello?" into silence, and the
  agent answered only the "Hello?". `disable_greeting_interruption: true` throws
  away anything said over the greeting, and the greeting just got three words
  longer. The prompt now recovers from it (never re-ask, answer what they said),
  but the underlying loss is untested either way. The experiment is one line:
  flip that flag to `false` in lib/telnyx/assistant.ts, `pnpm assistant:sync`, and
  make three calls talking over the greeting on purpose. It was `false` once and
  line noise made the agent open with "I'm not sure I caught that", but that was
  before `interrupt_prediction_threshold: 0.4` existed, so the trade has moved.
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
