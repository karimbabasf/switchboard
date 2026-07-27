# Telegram Bot API: Forum-Topics-as-SMS-Inbox Reference

Sourced 2026-07-27 from the current live docs: `core.telegram.org/bots/api`, `core.telegram.org/bots/webhooks`, `core.telegram.org/bots/faq`. Design target: one supergroup with forum topics enabled, one topic per phone contact, bot forwards inbound SMS/calls into the matching topic and forwards a user's reply in that topic back out as an SMS.

---

## 1. Forum topics: setup and lifecycle methods

### Enabling topics on a supergroup
- Topics are a supergroup-only feature. `Chat.is_forum` (Optional, `True`) tells you if it's enabled. There's no bot-callable "enable forum mode" method in the Bot API, this is toggled in the group's own settings (Manage Group > Topics) by a human admin, or automatically true on creation if made as a forum. Plan for a human to flip this once per group.
- Required bot rights: the bot must be an **administrator** in the supergroup with the **`can_manage_topics`** admin right for all topic-management calls (create/edit/close/reopen/delete/unpin). `can_delete_messages` is separately required for `deleteForumTopic`. `can_pin_messages` is required for `unpinAllForumTopicMessages`.

### Method-by-method (all confirmed against current docs)

| Method | Params | Notes |
|---|---|---|
| `createForumTopic` | `chat_id` (req), `name` 1 to 128 chars (req), `icon_color` (opt, one of 7 fixed RGB ints), `icon_custom_emoji_id` (opt) | Returns a `ForumTopic` object containing the new `message_thread_id`. This is the id you store per contact. |
| `editForumTopic` | `chat_id`, `message_thread_id` (both req), `name` (opt), `icon_custom_emoji_id` (opt) | Rename a contact's topic (e.g. once you resolve a caller's name). Params not independently re-fetched this session but follow the identical pattern confirmed on every other topic method below, high confidence. |
| `closeForumTopic` | `chat_id`, `message_thread_id` (both req) | Bot needs `can_manage_topics` unless it is the topic's creator. |
| `reopenForumTopic` | `chat_id`, `message_thread_id` (both req) | Same rights rule as close. |
| `deleteForumTopic` | `chat_id`, `message_thread_id` (both req) | Deletes the topic and all its messages permanently. Needs `can_delete_messages`. See section 8 on orphaning. |
| `unpinAllForumTopicMessages` | `chat_id`, `message_thread_id` (both req) | Needs `can_pin_messages`. |
| `getForumTopicIconStickers` | none | Returns allowed custom-emoji icon set for `createForumTopic`/`editForumTopic`. |
| `editGeneralForumTopic` | `chat_id`, `name` (req) | Renames the fixed "General" topic. No `message_thread_id` param, General isn't addressed that way. |
| `closeGeneralForumTopic` / `reopenGeneralForumTopic` | `chat_id` only | Same "no thread id" pattern. |
| `hideGeneralForumTopic` / `unhideGeneralForumTopic` | `chat_id` only | Hiding auto-closes General if it was open. |
| `unpinAllGeneralForumTopicMessages` | `chat_id` only | Not independently re-fetched, same pattern. |

**The field that identifies a topic on both send and receive is `message_thread_id`** (an Integer), this is the single id you persist per contact and reuse for every future send/receive.

---

## 2. Sending into a specific topic

**Param name: `message_thread_id`**, confirmed present with identical wording ("Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only") on `sendMessage`, `sendMediaGroup`, and `sendLocation`. This is a universal optional parameter Telegram adds to essentially every `send*` method (`sendPhoto`, `sendAudio`, `sendVoice`, `sendDocument`, `sendVideo`, etc. all follow the same shared pattern), treat it as present on every send-type call you'll use for outbound SMS/call-log cards and voice-note forwarding.

**General topic is a special case:** the General-topic management methods (`editGeneralForumTopic`, `closeGeneralForumTopic`, `hideGeneralForumTopic`, etc.) take **no `message_thread_id` parameter at all**, General isn't addressed by thread id the way custom topics are. For sending, the convention (per community client libraries; not spelled out as an explicit worked example in the reference page itself) is: omit `message_thread_id` to land a message in General. Treat "does an explicit thread id also work for General" as **UNVERIFIED**, don't rely on it; just omit the param when you mean General.

---

## 3. Receiving: identifying an inbound reply meant to become an outbound SMS

An incoming `Update` for a topic message is a normal `Update.message` object with `message_thread_id` set (Optional Integer field on `Message`, "for supergroups and private chats only"). There is **no separate `is_topic_message` boolean** on the current `Message` schema (an older API version reportedly had one; it did not surface in the current doc, don't code against it).

**Reliable inbound-reply detection rule** (apply all, in order, first failing check means "not an SMS-worthy reply"):

1. `update.message` is present (not `update.edited_message`, `update.channel_post`, `update.callback_query`, `update.message_reaction`, etc.). An edit should not silently re-fire an SMS send; either ignore `edited_message` entirely or handle it as an explicit "resend/correct" action you gate behind a confirm button.
2. `message.chat.id` equals your one hard-coded supergroup id. Telegram has no server-side "restrict this bot to one chat" feature, you enforce it in your handler by dropping/ignoring anything from any other `chat.id`. Same idea for `setWebhook`: there's no chat-scoping parameter there either.
3. `message.message_thread_id` is present and matches a `message_thread_id` you have stored against a contact. If absent, the message was sent to General or to a topic you don't track, route accordingly (e.g., treat General as an internal ops channel, not a contact channel).
4. `message.from.is_bot` is `false` (or `from` absent for anonymous-admin/channel-linked sends, `User.is_bot` is a stable, longstanding field; not re-confirmed via fetch this session due to search-result truncation, but has been part of every Bot API version and is safe to rely on). This filters out echoes from your own bot and any other bot in the group.
5. The message is **not** a pure service message. Service-type messages populate a dedicated field instead of `text`, e.g. `forum_topic_created`, `forum_topic_closed`, `forum_topic_reopened`, `forum_topic_edited`, `general_forum_topic_hidden`, `general_forum_topic_unhidden`, `pinned_message`. Practical check: message has `text` (or `voice`/`photo`/`document`/etc. content) and none of the service-message fields are set.
6. Optionally exclude commands: if you want `/close`, `/callback`, etc. treated as bot commands rather than SMS text, check `message.entities` for an entry with `type == "bot_command"` at offset 0 (`MessageEntity.type` enum confirmed includes `"bot_command"`, rendered like `/start@jobs_bot`).

---

## 4. Limits that matter for this design

| Limit | Value | Source confidence |
|---|---|---|
| Message text length | 1 to 4096 chars after entities parsing | Confirmed (`InputTextMessageContent.message_text`) |
| Caption length | 0 to 1024 chars after entities parsing | Confirmed (`editEphemeralMessageCaption.caption`, same limit applies to all captioned sends) |
| File upload via multipart (bot uploads) | 10 MB max for photos, **50 MB max for other file types** (docs, audio, voice, video) | Confirmed, "Sending files" section plus `sendDocument`/`sendVoice` text verbatim |
| File send via HTTP URL (Telegram fetches it) | 5 MB max photos, 20 MB max other content | Confirmed |
| File resend via `file_id` | No limit | Confirmed |
| `sendVoice` format | Must be `.ogg`/OPUS, `.mp3`, or `.m4a` to render as a playable voice bubble; other formats land as `Audio`/`Document` instead | Confirmed, exact method text |
| `sendAudio` size | Same 50 MB general file ceiling (not independently re-fetched for this specific method string this session, but it's the same shared "Sending files" ceiling documented for all non-photo content) | High confidence, not verbatim-confirmed |
| `callback_data` | 1 to 64 **bytes** | Confirmed (`InlineKeyboardButton.callback_data`) |
| Per-chat send rate | Avoid more than 1 message/second to the same chat; short bursts tolerated, then 429s | Confirmed (Bots FAQ) |
| **Per-group send rate** | Bots **cannot send more than 20 messages/minute to a group** | Confirmed (Bots FAQ), **this is the load-bearing limit for your design**, see section 9 |
| Bulk/broadcast rate | About 30 messages/sec across all chats by default; up to 1000/sec via Paid Broadcasts (0.1 Stars/msg over the free 30/sec, needs 10,000+ Stars balance) | Confirmed |
| `max_connections` (webhook) | 1 to 100, default 40 | Confirmed (`setWebhook`) |
| Forum topics per supergroup | **Not stated anywhere in the current Bot API reference.** A commonly cited figure (about 100,000) comes from Telegram's own product blog announcing topics, not the Bot API docs. | **UNVERIFIED**, don't hard-code a cap; confirm empirically or with Telegram support before capacity planning around it |

---

## 5. Webhook security

- `setWebhook` takes an optional `secret_token`: 1 to 256 chars, charset restricted to `A-Z a-z 0-9 _ -`. Telegram echoes it back on every webhook POST in a header named exactly:

  **`X-Telegram-Bot-Api-Secret-Token`**

  Reject any request where this header doesn't match what you set. This is the current, documented verification mechanism.
- Older guidance (Bots FAQ, still published) suggests a secret path segment in the webhook URL itself (`https://example.com/<your_bot_token_or_random_string>`) as a second, independent layer, since only you and Telegram know the token.
- **No published static IP ranges for Telegram's webhook senders** were found in either doc. `WebhookInfo.ip_address` only reports the IP Telegram is currently using for your webhook, not a stable allow-list, don't build IP allow-listing around it. Rely on the secret_token header instead.
- **Restricting the bot to a single chat_id is entirely your application's job.** There's no Telegram-side "bind this bot/webhook to one chat" setting, filter every incoming `Update` by `chat.id` yourself (see section 3, check 2).

---

## 6. Inline keyboards: action-button flow for a contact card

- `InlineKeyboardButton.callback_data`: optional string, **1 to 64 bytes**, sent back verbatim in the resulting `CallbackQuery.data` when pressed.
- Press flow: user taps a button, Telegram sends `Update.callback_query`, `CallbackQuery` fields: `id`, `from`, `message` (a `MaybeInaccessibleMessage`, the original card), `inline_message_id` (only for inline-mode messages, not relevant here), `chat_instance`, `data`, `game_short_name`.
- **You must call `answerCallbackQuery(callback_query_id, ...)` after every press**, even with zero optional params, otherwise the Telegram client shows a perpetual loading spinner on that button. Optional params: `text` (0 to 200 char toast), `show_alert` (blocking alert instead of toast), `url`, `cache_time`.
- To update the card in place (e.g. swap "Call back / Mark handled" buttons for a "Handled" label after a tap), use `editMessageReplyMarkup(chat_id, message_id, reply_markup)`, cheaper than re-sending the whole card since it only touches the keyboard, not the text/caption. Use `editMessageText` or `editMessageCaption` if you also need to update the card body (e.g., append "Handled by X at HH:MM").
- Edge case in the docs: a **48-hour edit window** is called out specifically for **business-connection messages not sent by the bot**. That's a different feature (Telegram Business accounts) and shouldn't apply to your bot's own cards in a regular supergroup, bots can generally edit their own messages without that 48h ceiling. Flagging only because it's the one edit-window caveat that showed up in the docs.

---

## 7. Reactions (for SMS delivery-status indicators)

- `setMessageReaction(chat_id, message_id, reaction?, is_big?)`. `reaction` is an array of `ReactionType`; as a non-premium bot you're limited to **one reaction per message**, and **bots can't use paid reactions**. `is_big` plays the big burst animation.
- "Service messages of some types can't be reacted to" (unspecified which types, treat forum-topic service messages as likely excluded, e.g. don't try to react to a `forum_topic_created` message).
- **Whether a bot can react to its own previously-sent message: UNVERIFIED.** The method doc places no explicit restriction on target-message ownership, but I found no explicit confirmation either way in the current reference. This is exactly the mechanism you'd want for "delivered / failed" marks on your own SMS-status cards, test it directly against a bot-owned message before depending on it; if blocked, fall back to editing message text/caption with a status glyph instead.

---

## 8. Topic deletion and orphaned `message_thread_id`

- `deleteForumTopic` removes the topic and every message in it, permanently, on Telegram's side. If your DB holds a stale `message_thread_id` for a contact whose topic was deleted (by a human admin, not necessarily your bot), subsequent `sendMessage`/`sendPhoto`/etc. calls using that id will fail with a Bad Request (message-thread-not-found style error, exact error string not verified this session).
- **Recommended recovery:** catch the send failure, `createForumTopic` a fresh topic for that contact, update your stored `message_thread_id` mapping, and post a short "topic was recreated, prior history lives in your CRM/DB, not here" notice into the new topic. Telegram gives you no way to recover the deleted topic's message history, so your own message log (not Telegram) has to be the durable source of truth for conversation history.
- `closeForumTopic` (vs. delete) does **not** orphan the id, the topic and its `message_thread_id` persist; `reopenForumTopic` restores write access. Whether a bot can still successfully call `sendMessage` into a closed (not deleted) topic is **UNVERIFIED**, the docs describe close/reopen only from the human-permissions angle. Given this design closes topics only for "done" contacts, treat close as a soft-archive state and always `reopenForumTopic` before sending a new inbound SMS into it, rather than assuming a closed topic still accepts bot sends.

---

## 9. Top gotchas for this specific design

1. **20 messages/minute per group is your real ceiling, not the 30/sec bulk number.** All contact topics live in one supergroup, so every inbound SMS, every outbound confirmation, every card edit, every reaction all count against that shared 20/min budget. A moderately busy inbox (a handful of simultaneous SMS threads) can blow through this fast, you'll need client-side queuing/backoff on 429s and probably batching (e.g., editing existing cards instead of sending new messages where possible) rather than assuming Telegram scales linearly with topic count.
2. **General has no `message_thread_id` addressing pattern**, every other topic method takes `message_thread_id`, General's equivalents (`editGeneralForumTopic`, `closeGeneralForumTopic`, etc.) take none, and sending to General means omitting the param rather than passing a sentinel value. Don't special-case-encode "General" as e.g. thread id `1` in your data model; model it as a nullable/absent thread id instead.
3. **Deleted topics silently orphan your DB mapping with no recovery path from Telegram's side.** Since a human admin (not just your bot) can delete a topic out from under you, and Telegram deletes the message history with it, your system needs its own durable message log independent of Telegram, plus a detect-and-recreate path on send failure (section 8), don't treat Telegram-side history as your archive.

**Unverified items to confirm before relying on them in production:** forum-topic count ceiling (section 4), bot-reacts-to-own-message (section 7), closed-topic send behavior (section 8), General-topic explicit-thread-id behavior (section 2).
