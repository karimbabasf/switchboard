# Testing the line by hand

Written 2026-08-03, after the day-one build. Everything below is live right now.

## Before you start

**Call and text +1 555 555 0124.** That is the Telnyx number this system answers.
The published number, (555) 555-0158, is still on Google Voice and is not ported,
so nothing you do to it touches any of this.

**Texts only reach your own phone.** `SMS_ALLOWLIST` is `+14155550142` and
nothing else, so `sendSms` refuses every other recipient. That is deliberate and
it keeps test texts on one phone until 10DLC is approved.

**It all runs on this laptop behind a cloudflared quick tunnel.** If the machine
sleeps or the tunnel drops, the phone goes dead with no warning anywhere. To
bring it back:

    pnpm repoint https://the-new-tunnel-hostname.trycloudflare.com
    pnpm assistant:sync

`pnpm preflight` (22 checks) answers "is any of this even plugged in" before you
start chasing a symptom.

---

## A. The call

The three fixes here are latency, eager end-of-turn, and the outbound voice
profile. The third one has never worked, so item 6 is the most interesting test
on this page.

1. **Time the answer.** Call and count to first audio. It was 5.8 seconds, it
   should now be roughly 2 to 3. If it still feels like five, the tunnel is
   adding hops or `next dev` is cold; call twice.
2. **Talk over the greeting.** Start speaking immediately. The agent cannot hear
   you during the greeting by design, so it should ask ONCE: "Sorry, I missed
   that. What can I get for you?" It must not loop that question.
3. **Ask who you are speaking to.** "Who is this?" or "Are you a real person?"
   It should answer straight, every time you ask, not once.
4. **Ask for a price.** "How much is a pallet of bubble wrap?" It must not say a
   number. It should offer to text the list or point at the site.
5. **Ask about delivery.** "Do you deliver?" Expect will call Monday to Friday
   8am to 4pm, and delivery as orders in by Tuesday go out Thursday. If you hear
   "delivery and will call both run Monday to Friday", the sync did not take.
6. **Ask for a human.** "Can I speak to someone?" **Your phone should ring.**
   This path has never once worked: the Call Control app had no outbound voice
   profile, so every dial failed silently while the inbound half looked healthy.
   If your phone does not ring, that is the single most important thing to say.
7. **Listen to the pace mid-call.** Eager end-of-turn was disabled by a default
   until today, so replies should start noticeably sooner after you stop talking.
   This is a feel test, not a stopwatch one.

## B. The texts

All from your own phone, to +1 555 555 0124. "Auto" means it replies by itself in
a second or two. "Card" means nothing is sent to the customer and a card appears
in the Telegram group waiting for a tap.

| Text this | Expect |
|---|---|
| `what do you sell` | Auto. The six products, no prices. |
| `do you deliver or can I pick up` | Auto. **New today.** Will call address, hours, and the Tuesday/Thursday cadence. |
| `what's your address` | Auto. **Changed today.** Leads with 1234 Example Way, not a phone number. |
| `what are your hours` | Auto. |
| `can you do better on that price` | **Card, never auto.** Bargaining is always a human. |
| `whats your best price on tape` | **Card.** Same rule, and this one used to slip through the quote template. |
| `can you deliver Thursday` | **Card.** A date for their order is a promise, not a fact. |
| `is my order ready to pick up` | **Card.** Contains "pick up" and is deliberately NOT answered by the delivery template. |
| `can you make it 5 instead of 3` | **Card, new today.** Order change: their words, the matched order, its lines, and an Apply button if the quantity parsed. |
| `STOP` | Nothing sent back, ever again. This writes `contacts.opted_out_at` and the door refuses that number from then on. Only test this if you are willing to clear the column afterwards. |

## C. Telegram

8. **Tap Send on any draft card.** The text should reach your phone and the card
   should lose its buttons so it cannot be sent twice.
9. **Type a reply directly in a contact's topic.** It should go out as an SMS.
10. **Both of those were dead until today** because nothing in the repo ever set
    the Telegram webhook, so a tunnel restart silently killed every button. If
    they work, that fix is confirmed.

## D. What cannot be tested yet

**The Apply button on an order-change card.** Akme's pipeline cron is paused, so
there is no live order in a changeable status to tap it against. The card and the
button are real; the write at the far end has only been unit tested. Turning
Akme's pipeline back on is Tuesday's work, and this is the first thing to try
once there is a real order sitting in `awaiting_approval` or `quote_sent`.

Only Karim can tap Apply. `responders.telegram_user_id` is set to 123456789, so
anyone else in the group gets "You are not set up to change orders".
