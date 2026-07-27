Telnyx Voice + Messaging Reference (Call Control v2 / Messaging API)

Researched 2026-07-27 against live developers.telnyx.com and telnyx.com/pricing docs. Target stack:
Next.js route handlers on Vercel (Node runtime), official `telnyx` Node SDK.

All commands below are Call Control v2, base URL `https://api.telnyx.com/v2`.
Node SDK calls shown alongside raw REST paths.

---

## 1. Inbound call flow: exact events + commands

### Webhook events (in order), each `developers.telnyx.com/api-reference/callbacks/<slug>`

| Event (`data.event_type`) | Fired when | Doc |
|---|---|---|
| `call.initiated` | Inbound call hits your Call Control connection. `payload.state` is `"parked"` until you `answer` it. | [call-initiated](https://developers.telnyx.com/api-reference/callbacks/call-initiated) |
| `call.answered` | After your `answer` command succeeds | [call-answered](https://developers.telnyx.com/api-reference/callbacks/call-answered) |
| `call.speak.ended` | After a `speak` command finishes playing | [call-speak-ended](https://developers.telnyx.com/api-reference/callbacks/call-speak-ended) |
| `call.recording.saved` | Recording file is ready | [call-recording-saved](https://developers.telnyx.com/api-reference/callbacks/call-recording-saved) |
| `call.recording.error` | Recording failed | [call-recording-error](https://developers.telnyx.com/api-reference/callbacks/call-recording-error) |
| `call.bridged` | Two legs successfully bridged | [call-bridged](https://developers.telnyx.com/api-reference/callbacks/call-bridged) |
| `call.machine.detection.ended` | AMD result available (`result`: `human`, `machine`, or `not_sure`) | [call-machine-detection-ended](https://developers.telnyx.com/api-reference/callbacks/call-machine-detection-ended) |
| `call.hangup` | Either leg ends. Payload includes `hangup_cause`, `hangup_source`, `sip_hangup_cause`, `call_quality_stats`. | [call-hangup](https://developers.telnyx.com/api-reference/callbacks/call-hangup) |

`call.initiated` payload example (confirms fields): `call_control_id`, `connection_id`, `call_leg_id`, `call_session_id`, `client_state`, `from`, `to`, `direction`, `state`. Source: [call-initiated](https://developers.telnyx.com/api-reference/callbacks/call-initiated).

`call.hangup` payload additionally carries `start_time`, `state: "hangup"`, `hangup_cause` (e.g. `call_rejected`, `timeout`), `hangup_source` (`caller` or `callee`), `sip_hangup_cause`. Source: [call-hangup](https://developers.telnyx.com/api-reference/callbacks/call-hangup).

### Commands (ordered sequence: answer, disclosure, record, dial second leg, bridge, hangup)

| Step | REST | Node SDK | Required params | Key optional params |
|---|---|---|---|---|
| 1. Answer inbound leg | `POST /v2/calls/{call_control_id}/actions/answer` | `client.calls.actions.answer(id, {...})` | `call_control_id` (path only) | `record` (`record-from-answer`), `record_channels` (default `dual`), `record_format` (default `mp3`), `transcription`, streaming params |
| 2. Speak disclosure | `POST /v2/calls/{call_control_id}/actions/speak` | `client.calls.actions.speak(id, {payload, voice, language})` | `payload` (text) | `voice`, `language`, `payload_type` |
| 3. Start recording (if not started at answer) | `POST /v2/calls/{call_control_id}/actions/record_start` | `client.calls.actions.startRecording(id, {channels, format})` | `format` (`wav` or `mp3`), `channels` (`single` or `dual`) | `play_beep`, `max_length`, `timeout_secs`, `transcription`, `transcription_engine`, `transcription_language` |
| 4. Dial second leg | `POST /v2/calls` | `client.calls.dial({connection_id, from, to})` | `connection_id`, `from`, `to` | `timeout_secs` (default 30, min 5, max 600), `answering_machine_detection`, `webhook_url`, `client_state` |
| 5. Bridge the two legs | `POST /v2/calls/{call_control_id}/actions/bridge` | `client.calls.actions.bridge(leg_a_id, {call_control_id_to_bridge_with: leg_b_id})` | `call_control_id` (path, leg A), `call_control_id_to_bridge_with` (body, leg B) | none |
| 6. Hang up | `POST /v2/calls/{call_control_id}/actions/hangup` | `client.calls.actions.hangup(id)` | `call_control_id` | none |

Sources: [dial](https://developers.telnyx.com/api-reference/call-commands/dial), [answer-call](https://developers.telnyx.com/api-reference/call-commands/answer-call), [speak-text](https://developers.telnyx.com/api-reference/call-commands/speak-text), [recording-start](https://developers.telnyx.com/api-reference/call-commands/recording-start), [bridge-calls](https://developers.telnyx.com/api-reference/call-commands/bridge-calls), [hangup-call](https://developers.telnyx.com/api-reference/call-commands/hangup-call).

Full sequence for your use case (disclosure then bridge to a live number):

```
inbound call: call.initiated (state: parked)
  -> POST /v2/calls/{A}/actions/answer
call.answered (leg A)
  -> POST /v2/calls/{A}/actions/speak  ("this call may be recorded...")
call.speak.ended (leg A)
  -> POST /v2/calls/{A}/actions/record_start  (channels: dual)
  -> POST /v2/calls  (dial leg B, same connection_id, to: destination)
call.initiated (leg B, direction: outgoing)
  EITHER call.answered (leg B) -> POST /v2/calls/{A}/actions/bridge {call_control_id_to_bridge_with: B}
         call.bridged (both legs)
  OR     call.hangup (leg B, hangup_cause: timeout, no_answer, user_busy, or call_rejected) -> voicemail fallback (section 4)
... conversation ...
call.hangup (either leg) -> call.recording.saved (recording_urls ready)
```

---

## 2. Recording

- Start via `record_start` (mid-call) or `record: "record-from-answer"` on the `answer` command itself.
- Dual channel: `channels: "dual"` (or `record_channels: "dual"`, the default on `answer`). Result is a stereo file, first/answering leg on channel A, the rest on channel B. Formats: `wav` or `mp3`.
- Storage: by default Telnyx stores the file in a Telnyx-owned S3 bucket and gives you a presigned URL in `call.recording.saved` (`recording_urls.mp3` / `.wav`); that presigned link is active for only 10 minutes, so download promptly or fetch again via the [recordings API](https://developers.telnyx.com/api-reference/call-recordings/retrieve-a-call-recording). You can instead point Telnyx at your own S3, GCS, or Azure Blob bucket via `POST /v2/custom_storage_credentials/{call_control_application_id}` with `backend: s3|gcs|azure`, then `recording_urls` in the webhook points at your bucket instead. Source: [storing-call-recordings](https://developers.telnyx.com/docs/voice/programmable-voice/storing-call-recordings).
- Retention of Telnyx's own copy: UNVERIFIED. The docs describe the 10 minute presigned link expiry but do not state how long the underlying file persists in Telnyx's bucket before deletion. Recommend using your own storage bucket if you need a guaranteed retention window, or check Mission Control Portal account/compliance settings directly.
- Success event: `call.recording.saved`, payload: `call_control_id`, `call_leg_id`, `call_session_id`, `channels`, `format`, `recording_started_at`, `recording_ended_at`, `recording_urls` (object keyed by format), `public_recording_urls`. Source: [call-recording-saved](https://developers.telnyx.com/api-reference/callbacks/call-recording-saved).
- Failure event: `call.recording.error`, payload includes `reason`. Source: [call-recording-error](https://developers.telnyx.com/api-reference/callbacks/call-recording-error).

---

## 3. Bridging: dial+bridge vs. transfer

- Dial (`POST /v2/calls`) originates a brand new outbound leg with its own `call_control_id`. It does not connect that leg to anything else.
- Bridge (`POST /v2/calls/{id}/actions/bridge`) takes two existing `call_control_id`s and merges their audio.
- Transfer (`POST /v2/calls/{id}/actions/transfer`) is a single combined command: it dials a new destination and bridges it to the existing call automatically, in one call control action.

For your disclosure-then-connect use case, use Dial + Bridge, not Transfer. Reasoning: Transfer gives you no independent `call_control_id` for the second leg while it is ringing, so you cannot run a distinct webhook/state machine for AMD, timeout, or voicemail on that leg, and there is no window to guarantee the disclosure message finishes on leg A before leg B is dialed. Dial+Bridge costs one extra API call and one extra webhook branch, but gives full control over ordering (speak, record, dial, bridge) and per-leg event handling (AMD result, no answer fallback). Transfer is the right call only when you want a single fire and forget "connect this call elsewhere" with no pre-roll and no independent control of the second leg.

Sources: [dial](https://developers.telnyx.com/api-reference/call-commands/dial), [bridge-calls](https://developers.telnyx.com/api-reference/call-commands/bridge-calls), [transfer-call](https://developers.telnyx.com/api-reference/call-commands/transfer-call).

---

## 4. Voicemail fallback (no answer on the bridged leg)

- `dial`'s `timeout_secs` (default 30s, min 5, max 600) bounds how long Telnyx waits for leg B to answer. On expiry: "the call will hangup and a `call.hangup` webhook with a `hangup_cause` of `timeout` will be sent." Source: [dial](https://developers.telnyx.com/api-reference/call-commands/dial) (body param docs).
- Other `hangup_cause` values you will see on the dialed leg: `call_rejected` (confirmed in the callback example payload), and commonly `user_busy`/`no_answer` in practice (not directly quoted in a fetched example, treat as standard SIP cause passthrough).
- Fallback pattern: in your webhook handler, on `call.hangup` for leg B with `hangup_cause` in `{timeout, no_answer, user_busy, call_rejected}` and leg A (the caller) still active: `speak` a "please leave a message" prompt on leg A, then `record_start` (if not already recording from the disclosure step) and let the caller talk until they hang up or a max length is reached, then `hangup`.
- To distinguish "leg B picked up but it's voicemail" from "leg B never answered," add Answering Machine Detection to the `dial` (`answering_machine_detection: detect`, `detect_beep`, `detect_words`, or `premium`), then branch on `call.machine.detection.ended` (`result: human`, `machine`, or `not_sure`); free with standard AMD or $0.0065/call for Premium AMD, either way you only pay call cost per Telnyx's pricing page. Source: [answering-machine-detection](https://developers.telnyx.com/docs/voice/programmable-voice/answering-machine-detection), [call-machine-detection-ended](https://developers.telnyx.com/api-reference/callbacks/call-machine-detection-ended).

---

## 5. Messaging API

### Send (SMS/MMS)

`POST https://api.telnyx.com/v2/messages`, required: `from`, `to`, `text`. For MMS add `media_urls` (array of publicly reachable URLs) and optional `subject`; `from` must be an MMS enabled number. Node: `client.messages.send({from, to, text, subject, media_urls})`. Source: [send-message](https://developers.telnyx.com/docs/messaging/messages/send-message).

### Inbound webhook: `message.received`

Payload: `payload.from.phone_number`, `payload.text`, `payload.type` (`SMS` or `MMS`), `payload.media[]` (`content_type`, `url`) when MMS. Source: [receive-message](https://developers.telnyx.com/docs/messaging/messages/receive-message).

### Delivery lifecycle events

- `message.sent`: outbound message accepted and handed to the carrier.
- `message.finalized`: terminal state (delivered or failed); this is your delivery receipt. Example payload fields: `completed_at`, `cost`, `direction`, `encoding`, `errors[]`, `from{carrier,line_type,phone_number,status}`, `parts`, `received_at`, `sent_at`, `to[]{carrier,line_type,phone_number,status}`. Source: [Telnyx webhook support article](https://support.telnyx.com/en/articles/4334722-how-to-leverage-webhooks).

### Messaging profiles and numbers

A messaging profile is the config object: it groups phone numbers, sets `webhook_url`/`webhook_failover_url`, and controls Number Pool, Sticky Sender, Geomatch, Smart Encoding, MMS Transcoding, Spend Limits, URL Shortening. Every number used for messaging must be assigned to a profile. Create with `POST /v2/messaging_profiles`, assign a number with `POST /v2/messaging_profiles/{profile_id}/phone_numbers`. Source: [messaging-profiles-overview](https://developers.telnyx.com/docs/messaging/messages/messaging-profiles-overview).

### Messaging webhook delivery behavior (see also section 8)

Timeout 2s, up to 3 retries plus 3 more to a failover URL (6 total), any 2xx counts as success, any non-2xx (including 3xx) counts as failure and retries. Source: [receiving-webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks).

---

## 6. Webhook signature verification

- Algorithm: Ed25519. Compatible with the Standard Webhooks spec.
- Headers: `telnyx-signature-ed25519` (base64 signature), `telnyx-timestamp` (Unix seconds).
- Signs `timestamp|payload` over the raw request body; you must pass the exact bytes Telnyx sent, not a re-serialized or re-parsed object.
- Public key: Mission Control Portal, Account Settings, Keys & Credentials, Public Key tab.
- Node SDK method: `telnyx.webhooks.constructEvent(rawBody, signatureHeader, timestampHeader, publicKey)`, throws on failure. A lower-level `telnyx.webhooks.signature.verifySignature(rawBody, signatureHeader, timestampHeader, publicKey, toleranceSeconds)` also exists for a custom timestamp tolerance window.

Sources: [receiving-webhooks (messaging)](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks), [update-webhook-sign-key-guide](https://support.telnyx.com/en/articles/8370064-update-webhook-sign-key-guide).

Node example (adapt for a Next.js route handler; see gotcha in section 8 about raw body):

```js
import Telnyx from 'telnyx';
const telnyx = new Telnyx(process.env.TELNYX_API_KEY);

export async function POST(request) {
  const rawBody = await request.text(); // must be the raw, unparsed body
  const signature = request.headers.get('telnyx-signature-ed25519');
  const timestamp = request.headers.get('telnyx-timestamp');

  let event;
  try {
    event = telnyx.webhooks.constructEvent(
      rawBody,
      signature,
      timestamp,
      process.env.TELNYX_PUBLIC_KEY,
    );
  } catch (err) {
    return new Response('Invalid signature', { status: 403 });
  }

  // event.data.event_type, event.data.payload ...
  return new Response(null, { status: 200 });
}
```

---

## 7. Pricing (US, pay as you go, no volume commitment)

| Item | Rate | Source |
|---|---|---|
| Outbound voice | $0.002/min (Call Control) plus SIP Trunking fee (advertised blended ~$0.007/min) | [pricing/voice-api](https://telnyx.com/pricing/voice-api) |
| Inbound voice (local or toll free) | $0.002/min plus SIP Trunking inbound fee | [pricing/voice-api](https://telnyx.com/pricing/voice-api) |
| Call recording | $0.002/min | [pricing/voice-api](https://telnyx.com/pricing/voice-api) |
| Call recording storage | $0/min (free) | [pricing/voice-api](https://telnyx.com/pricing/voice-api) |
| Standard AMD | $0.002/call | [pricing/voice-api](https://telnyx.com/pricing/voice-api) |
| Premium AMD | $0.0065/call | [pricing/voice-api](https://telnyx.com/pricing/voice-api) |
| Call transfer | $0.10/invocation | [pricing/voice-api](https://telnyx.com/pricing/voice-api) |
| Local/10DLC number, monthly | $1/month | [10dlc-vs-toll-free-isvs](https://telnyx.com/resources/10dlc-vs-toll-free-isvs) (cites telnyx.com/pricing/numbers) |
| 10DLC registration | $4 base plus $15/campaign plus optional $15 brand vetting | [10dlc-vs-toll-free-isvs](https://telnyx.com/resources/10dlc-vs-toll-free-isvs) |
| SMS (local/10DLC), outbound | $0.004/part plus carrier fee | [pricing/messaging](https://telnyx.com/pricing/messaging) |
| SMS (local/10DLC), inbound | $0.004/part plus carrier fee | [pricing/messaging](https://telnyx.com/pricing/messaging) |
| MMS (local/10DLC), outbound | $0.015/part plus carrier fee | [pricing/messaging](https://telnyx.com/pricing/messaging) |
| MMS (local/10DLC), inbound | $0.005/part plus carrier fee | [pricing/messaging](https://telnyx.com/pricing/messaging) |
| Carrier fee example (AT&T) | $0.0035/part SMS, $0.009/part MMS (outbound) | [pricing/messaging](https://telnyx.com/pricing/messaging) |
| Carrier fee example (T-Mobile) | $0.0045/part SMS, $0.01/part MMS (outbound) | [pricing/messaging](https://telnyx.com/pricing/messaging) |

Carrier fees are charged on top of the base per-part rate on every message and vary by destination carrier; budget them as a separate line item, they are not optional or foldable into the base rate.

---

## 8. Serverless / Vercel gotchas

1. Webhook response deadline is tight. Messaging webhooks: 2 second timeout, then Telnyx retries up to 3x per URL with exponential backoff, then 3 more to a failover URL if configured (6 total attempts). Any non-2xx (including 3xx redirects) counts as failure and triggers a retry. Source: [receiving-webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks). Design for this: acknowledge with 200 immediately, do the real work after or asynchronously; do not run slow DB or third party calls before responding.
2. Idempotency is mandatory. Because of retries (webhooks "may be delivered more than once"), dedupe on `data.id` before processing, and use `data.occurred_at` to handle out of order delivery rather than assuming arrival order matches event order. Source: [receiving-webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks).
3. Raw body handling breaks easily in Next.js. Signature verification needs the exact bytes Telnyx sent; in a Next.js route handler use `await request.text()` and pass that directly to `constructEvent`, do not `JSON.parse()` then `JSON.stringify()` the body first (whitespace or key order changes will invalidate the signature). This is a generic raw body pitfall, not a Telnyx doc stated warning; treat it as an implementation note rather than an official gotcha.
4. IP allowlisting, if you firewall inbound webhook traffic: Telnyx's outbound webhook subnet is `192.76.120.192/27` per the messaging docs (voice callbacks likely share the same infrastructure, not separately confirmed). Source: [receiving-webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks).

---

## Endpoint quick reference (all under `https://api.telnyx.com/v2`)

- `POST /calls`: dial
- `POST /calls/{id}/actions/answer`: answer
- `POST /calls/{id}/actions/speak`: speak text
- `POST /calls/{id}/actions/gather_using_speak`: speak plus collect DTMF
- `POST /calls/{id}/actions/record_start`: start recording
- `POST /calls/{id}/actions/bridge`: bridge two legs
- `POST /calls/{id}/actions/transfer`: dial plus auto-bridge in one step
- `POST /calls/{id}/actions/hangup`: hang up
- `POST /messages`: send SMS/MMS
- `POST /messaging_profiles`: create messaging profile
- `POST /messaging_profiles/{id}/phone_numbers`: assign number to profile
- `POST /custom_storage_credentials/{call_control_application_id}`: bring your own recording storage
