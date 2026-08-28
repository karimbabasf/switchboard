# Switchboard 2.0: going live, and getting back

Written 2026-08-27, after the build. Every command here was run except the last
two, which are the ones that change what a real caller hears.

## What is already done

- `switchboard-2` is deployed at https://switchboard.example.com
- The migration is applied to the dev Supabase (`your-dev-project-ref`), which is
  the database both this repo and akme-dev use
- Akme `dev` is pushed and deployed. `/order/<token>` returns 200 from outside
  the password wall, `/api/catalog` returns the six prices, `/api/stock` is up,
  and everything else on akme-dev is still 401
- `pnpm preflight`: all 27 checks pass
- `pnpm vitest run`: 678 pass, 0 fail. `npx tsc --noEmit`: clean

## The assistant is already made

`pnpm assistant:sync` has been run. It created **Akme line 2**,
`assistant-00000000-0000-4000-8000-000000000002`, with all nine tools pointing
at switchboard-2. The live assistant, **Akme line**,
`assistant-00000000-0000-4000-8000-000000000001`, still has its six tools and
still points at switchboard-v1. Nothing on the phone has changed.

**It went wrong the first time and the fix is in the repo.** The plan was that
a blank `TELNYX_ASSISTANT_ID` would make the sync CREATE rather than overwrite.
It does not: the script falls back to finding an assistant BY NAME, the fork
carried the same name as v1, and the first sync rewrote the live assistant with
this repo's brief and tool URLs. Nobody called in the ninety seconds before it
was caught and reverted, and that was luck rather than design. Two things now
stop it: the assistant here is named `Akme line 2`, and `assistant-sync.mts`
refuses outright if the id it is about to write is v1's.

## The one step that changes the live line

```bash
cd ../switchboard-2
pnpm repoint https://switchboard.example.com
```

That is the only command left, and it is the one that moves real callers. It changes five things at once:
the Call Control webhook, the messaging webhook, the assistant's tool URLs, the
Telegram webhook, and `switchboard_settings.public_base_url` which the pg_cron
worker reads.

## Getting back

One command, and it is the same command:

```bash
cd ../switchboard   # the v1 repo, untouched
pnpm repoint https://switchboard-v1.example.com
```

That puts all five back. The v1 assistant is
`assistant-00000000-0000-4000-8000-000000000001` and was never modified, so
there is nothing to restore about it.

The Telegram webhook is the one to watch. One bot has one webhook, so whichever
repo repointed last owns it. Cards keep arriving either way because those are
outbound; it is the button taps and typed replies that go to whoever holds it.
That is the failure that is silent in both directions, which is why it is in the
repoint script rather than in a checklist.

Nothing needs undoing in the database. `phone_order_quotes` and
`phone_order_drafts` are new tables that nothing else reads, so leaving them is
free.

## What is not built

Telegram gets its own group and its own order card later, Karim's call. The
draft row already carries `large_order` for the card that does not exist yet.
Text and email automation are the next job.

## Known, not fixed

The rehearsal sat at 30/39 on 2026-08-27. v1, which answers real customers
today, scored 23/28 on the same harness through the same gateway, so this is not
worse than what is live. Two of the failures are v1's too. What is left:

- **The three sentence cap bites on a priced turn.** Reading the lines back, then
  the subtotal, then "would you like me to send you the confirmation link" is
  three sentences with nothing spare, and a longer order overruns. The fix is in
  the prompt rather than in the check: say the subtotal WITHOUT reading the lines
  back, since the customer is about to see every line on the form anyway. Called
  in advance by the agent that wrote the brief, before the run that proved it.
- **`order-prices-only-when-asked` is two rules disagreeing, not flakiness.**
  It priced all six on one run and answered "Which of those would you like a
  price on?" on the next, and "flaky" was the wrong word for it. The brief holds
  both of these, two lines apart:

      ONLY THE ONES THEY ASKED ABOUT ... Never walk the list ...
      A PRICE QUESTION WITH NO PRODUCT IN IT IS A QUESTION ABOUT ALL OF THEM ...
      Do not ask them which ones they meant.

  Pricing all six IS walking the list, so on a question naming no product the
  model is picking between two explicit instructions, and a coin flip is what
  that looks like from outside. The fix is the shape the price-pushback exception
  already uses: carve the no-product case INTO the never-walk-the-list rule, so
  there is one rule with a branch instead of two rules that contradict. Small
  edit, needs a paid run to confirm.
- **Two failures are inherited.** `complaint-then-yes-transfers` and
  `we-not-the-team` fail on v1 as well, so they are not this work's regressions
  and fixing them belongs to whoever next touches the shared brief.
- **The rehearsal is nondeterministic.** Three runs of the same code scored 28,
  28 and 30, with different scenarios failing each time. Judge a trend across
  runs, never a single number.

## The pattern worth looking for first

Three of the failures in this build were two rules disagreeing rather than a rule
missing: the offer-a-human carve out against the hold-the-price rule, the
text_me_the_list description against the new price tools, and the one above. The
same shape showed up in the harness four more times, where a check demanded the
behaviour Karim had just reversed, and `names-a-product` was the extreme case: a
check that had come to require the exact defect its own comment was written to
catch.

So when this line does something inconsistent, look for the second rule before
writing a third. Adding a rule to beat a rule is how the prompt got two of these
in the first place.
