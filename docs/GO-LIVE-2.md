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
