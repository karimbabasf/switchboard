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

## The two steps that change the live line

Nothing a caller hears changes until both of these run. The number still answers
on v1 until then.

```bash
cd ../switchboard-2
pnpm assistant:sync            # 1. makes a NEW Telnyx assistant, does not touch v1's
pnpm repoint https://switchboard.example.com   # 2. points the number here
```

`assistant:sync` is safe on its own. `TELNYX_ASSISTANT_ID` is deliberately blank
in this repo, so the sync CREATES an assistant rather than overwriting the one
answering the phone right now. That blank is the only thing standing between a
sync and a silent rewrite of the live line, so do not fill it in by hand.

`repoint` is the one that moves real callers. It changes five things at once:
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
