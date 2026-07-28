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
https://developers.telnyx.com/development/llms/ai-assistants-llms-full-txt.md
and, for call commands,
https://developers.telnyx.com/development/llms/calling-llms-full-txt.md

Field names in this area have moved more than once, and one that a plan for this
repo asserted from memory does not exist at all. Verified against the live docs
on 2026-07-28:

- There is **no** `interrupt_prediction_threshold`, anywhere, at any nesting
  level. Turn-taking is controlled by `interruption_settings.enable`,
  `interruption_settings.disable_greeting_interruption`, and
  `interruption_settings.start_speaking_plan.wait_seconds` (float, default 0.4).
  If you find yourself writing a threshold number, you are writing from memory.
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
  `POST /v2/calls/{call_control_id}/actions/ai_assistant_start` with body
  `{ "assistant": { "id": "assistant-..." } }`. It returns a `conversation_id`,
  and afterwards the call emits `call.conversation.ended` and
  `call.conversation_insights.generated`.
- Voice is a single string, `<Provider>.<Model>.<VoiceId>`, with any third-party
  key supplied as `voice_settings.api_key_ref`, never inline.
