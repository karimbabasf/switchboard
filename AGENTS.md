<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# The same applies to AssemblyAI

Fetch https://www.assemblyai.com/docs/llms.txt before writing or changing any
AssemblyAI code. Parameter names have moved and memorized ones are wrong:
`speech_models` is a plural array taking exactly `universal-3-5-pro` or
`universal-2`, the singular `speech_model` is deprecated, and `auto_chapters`,
`summarization`, `summary_model` and `summary_type` are gone (we summarize
through NEAR AI Cloud instead). A cast written to silence the SDK's types means
read the docs, not that the SDK is behind.

# And the same applies to Telnyx AI Assistants

The AI Assistants API postdates your training data. Before writing or changing
anything under `lib/telnyx/assistant.ts`, read
https://developers.telnyx.com/docs/development/llms/ai-assistants-llms-full-txt
and, for call commands,
https://developers.telnyx.com/docs/development/llms/calling-voice-api-llms-full-txt

Those two URLs moved on or before 2026-08-19; the old ones (under
`/development/llms/`, with a `.md` suffix) now 404. The current index of every
section file is https://developers.telnyx.com/llms.txt, so start there if these
404 too rather than assuming the docs are gone.

**For request and response SHAPES, prefer the OpenAPI spec over the guides.**
https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json
is complete where the guides are selective, and the guides were wrong by
omission about the two fields that mattered most here. Read it in a sandbox and
print the one path you need; it is 901 paths and does not belong in context.

**The docs are not the whole API here.** Several real fields are undocumented,
and Telnyx will accept a request containing a field it does not recognise,
return 200, and store nothing. So the rule in this area is stronger than reading
the docs: **`pnpm assistant:sync` reads the assistant back and fails if anything
sent was not stored.** Never trust a 200 from this API as confirmation.

Verified by pushing a real assistant and reading it back on 2026-07-28:

- `interruption_settings.interrupt_prediction_threshold` **does exist**, and is
  **not in the published docs**. It defaults to `0.0`, which means off. We set
  0.4 so a backchannel "mm-hm" does not cut the agent off while a real
  interruption still lands. An earlier pass grepped the docs, found nothing, and
  wrote here that the field did not exist. It does.
- The other turn-taking controls are `interruption_settings.enable`,
  `.disable_greeting_interruption`, and
  `.start_speaking_plan.wait_seconds` (float, default 0.4, we use 0.3).
- **Voice is `voice_settings.voice`, not a top-level `voice`.** A top-level
  `voice` is accepted with a 200 and silently ignored, and the assistant runs
  with the account default. The id must exist in
  `GET /v2/text-to-speech/voices` (4437 of them; the payload key is `voices`,
  not `data`). Format `<Provider>.<Model>.<VoiceId>`, e.g. `Telnyx.Bayan.Amanda`.
- `voice_settings.background_audio` is `{type, value, volume}`, `value: "office"`
  is valid, and **volume must be a tenth**: 0.35 is a 400, not a rounding.
- Keyterm boost is `transcription.settings.keyterm`, a **comma-separated
  string**, not an array. Supported by `deepgram/flux` and `deepgram/nova-3`.
- End-of-turn: `deepgram/flux` is a turn-taking model and owns end-of-turn
  itself. `start_speaking_plan.transcription_endpointing_plan` is documented for
  non turn-taking models, so setting it alongside Flux is how you get config
  that silently does nothing.
- Noise suppression is `telephony_settings.noise_suppression` (`krisp`,
  `deepfilternet`, or `disabled`).
- Tools nest: `{ type: 'webhook', webhook: { name, description, url, method,
  headers: [{name, value}], body_parameters: <JSON Schema> } }`.
- Caller context is `dynamic_variables_webhook_url`, with
  `dynamic_variables_webhook_timeout_ms` (default 1500, raise it for cold starts).
- Starting the agent on a live leg is
  `POST /v2/calls/{call_control_id}/actions/ai_assistant_start`. It returns a
  `conversation_id`, and afterwards the call emits `call.conversation.created`,
  `call.conversation.ended` and `call.conversation_insights.generated`.

  **The body is NOT just `{assistant: {id}}`**, which is what a comment in
  client.ts asserted until 2026-08-19 and what kept two useful fields unused.
  Off the OpenAPI spec: `assistant` takes `id` plus a per-call override of any
  stored field (`greeting`, `instructions`, `voice_settings`, `tools`,
  `external_llm`, **`dynamic_variables`**), and the body also takes
  `greeting`, `interruption_settings`, `transcription`, `message_history`,
  `participants`, `client_state` and **`command_id`**.

  - `assistant.dynamic_variables` supplies the caller context WITH the start,
    instead of Telnyx calling `dynamic_variables_webhook_url` back and holding
    the caller silent until it answers. Note it cannot switch the webhook off:
    there is no `dynamic_variables_webhook_url` in the per-call override list,
    so removing that round trip entirely means clearing it on the stored
    assistant.
  - `command_id` is on `ai_assistant_start`, `record_start`, `playback_start`
    and `speak`. Telnyx ignores a repeat of the same id on the same call, which
    is what lets a command be issued before our own exactly-once claim.

- Latency on this line is measured from `telnyx_events`, which stores both
  Telnyx's `occurred_at` and our `processed_at`. That is how the 2026-08-19 pass
  found that `call.speak.ended` cost 3.4-3.7s of OUR handling against 0.2-1.0s
  for every other event: the silence after the disclosure was Supabase round
  trips, not Telnyx. Measure there before tuning anything about the opening of a
  call.
- Voice is a single string, `<Provider>.<Model>.<VoiceId>`, with any third-party
  key supplied as `voice_settings.api_key_ref`, never inline.
