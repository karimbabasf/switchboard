# switchboard-2

Akme's phone line. An AI called Robin answers, handles the questions whose
answers already live in the catalogue and in QuickBooks, prices what is asked
about, takes an order, and texts a pre filled confirmation link the caller
finishes on the website. It escalates to a human on request or on low
confidence. Every call and text is recorded, transcribed and routed into a
Telegram supergroup, one forum topic per contact, two-way.

Forked from `switchboard` on 2026-08-27, history kept. Same Telnyx connection,
same number, same voice, same NEAR AI gateway, same Supabase, same env vars.
Everything about answering questions is unchanged. What is new is that the line
may say prices and may take an order.

Calls and SMS run on Telnyx. State lives in the shared `akme-dev` Supabase.
Recordings go to private Supabase Storage, transcripts to AssemblyAI, summaries
to NEAR AI Cloud.

**This repo has no QuickBooks credential and must never grow one.** Stock comes
from Akme over a signed call, for the reason `lib/akme/desk.ts` gives: the
repo that holds the customer records holds the QuickBooks token, and one token
refreshed by two processes is the bug that shipped the sync disabled.

`docs/superpowers/specs/2026-08-27-phone-orders-design.md` is the order taking
design and the frozen contracts. `docs/STATUS.md` is what works today and what
is only tested. `docs/RUNBOOK.md` is the ordered go-live sequence.

## Run it

```bash
pnpm install
cp .env.example .env.local   # then fill it in
pnpm preflight               # confirms every credential is live, not just present
pnpm dev
```

`pnpm preflight` is the gate. It makes a real call against every service and
names whatever is broken instead of failing as one blob. It also fetches
Akme's catalogue and fails if any of the six prices here has drifted from the
prices the order form charges. Do not start debugging behaviour until it is
green.

Webhooks need a public URL, so point a tunnel at port 3000 and use that host in
the Telnyx portal. See `docs/RUNBOOK.md`.

## Test it

```bash
pnpm vitest run                     # whole suite
npx tsc --noEmit -p tsconfig.json   # typecheck
pnpm rehearse                       # 39 scripted callers against the live model, about 12 cents
pnpm rehearse order                 # only the order taking scenarios
```

`pnpm rehearse` is the behaviour gate and `pnpm vitest run` is the code gate.
A passing rehearsal is not a passing system: it cannot hear the voice and it
cannot be talked over. It is the cheap check you clear before calling the
number yourself.
