# Realtime voice-AI stack for an inbound support line on Telnyx

Researched 2026-07-27. All prices/claims below are as fetched today; anything not directly confirmed in a source is marked UNVERIFIED.

## 1. Telnyx native Voice AI / AI Assistant

- **Cost/min**: about $0.05/min all-in base (orchestration plus telephony fraction plus variable LLM token cost), pay-as-you-go. Call recording $0.002/min. Transcription $0.025/min (Telnyx STT engine) or $0.05/min (Google STT engine).
  [Telnyx voice agents](https://telnyx.com/resources/best-voice-agents-for-customer-support), [G2 pricing](https://www.g2.com/products/telnyx-voice-ai-agents/pricing), [Speech to Text pricing](https://telnyx.com/pricing/speech-to-text)
- **Latency**: marketed sub-500ms RTT on Telnyx's Tier-1 carrier network (single stack: telephony, STT, LLM, and TTS all on Telnyx infra, no cross-vendor hop). This is a network/RTT figure, not a confirmed full turn-latency (STT + LLM + TTS) number, so treat true time-to-first-audio under load as **UNVERIFIED**.
- **Barge-in**: not explicitly documented in what I found; reasonable to assume handled since it's a competing packaged product, but **UNVERIFIED**, confirm with a live test call.
- **Tool calling**: Webhook tools, the agent calls out to your HTTP endpoint (configurable headers/integration secrets, path/query/body params), gets JSON back, continues the conversation. Reaches Postgres only via an HTTP shim (a small API in front of the DB), not a direct DB driver.
  [Async webhook tools](https://telnyx.com/release-notes/async-webhook-tools-ai-assistants), [dynamic variables](https://telnyx.com/release-notes/dynamic-variables-webhook-response)
- **Warm transfer**: native, first-class. Three modes: cold transfer, private warm transfer (brief human, then merge caller), conferenced warm transfer (AI stays on the line as a third party) via built-in `Invite` plus `Skip Turn` tools.
  [Warm transfers release note](https://telnyx.com/release-notes/warm-transfers-voice-ai), [AI-to-human handoff guide](https://telnyx.com/resources/ai-to-human-handoff-voice-ai)
- **Telnyx fit**: native, it's the platform's own product, zero telephony integration work.
- **Call recording**: native Telnyx call recording ($0.002/min) plus STT-based transcription, both first-party.
- **Build effort**: lowest of all four paths, config plus one webhook backend (any language/stack) for tool calls and transfer decisioning. Estimate **2 to 4 days**.

## 2. Managed voice agent platform on a Telnyx number via SIP

Compared Vapi and Retell AI (currently the two leaders); Bland AI included for completeness but is weaker on this specific ask.

### Vapi
- **Cost/min**: platform fee $0.05/min; real all-in cost (LLM, STT, TTS, and telephony passthrough) is **$0.15 to $0.40/min** depending on model/voice stack.
  [pxlpeak breakdown](https://pxlpeak.com/blog/ai-tools/vapi-pricing-breakdown), [Telnyx's own Vapi pricing page](https://telnyx.com/resources/vapi-pricing)
- **Telnyx fit**: documented both ways, import an existing Telnyx number into Vapi, or bring your own Telnyx SIP trunk for custom routing.
  [Telnyx+Vapi integration](https://support.telnyx.com/en/articles/12538402-telnyx-vapi-integration), [Vapi Telnyx SIP docs](https://docs.vapi.ai/advanced/sip/telnyx)
- **Warm transfer gotcha**: `transferCall` tool supports a `transferPlan` (blind, or warm with summary/custom-message/wait-for-human-to-speak modes), **but Vapi's own docs state warm transfer is currently available only with Twilio-based telephony**. On a Telnyx-imported number this is a real risk; assume cold transfer only until verified live.
- **Recording**: built-in, with an enterprise consent-flow assistant that auto-gates recording on spoken consent. [Vapi call recording docs](https://docs.vapi.ai/assistants/call-recording)

### Retell AI
- **Cost/min**: voice engine $0.07/min; realistic all-in **$0.13 to $0.31/min** (most setups land around $0.13 with a GPT-4.1-class model).
  [Cekura breakdown](https://www.cekura.ai/blogs/retell-ai-pricing-per-minute)
- **Telnyx fit**: Retell publishes a dedicated Telnyx deploy guide (elastic SIP trunk, FQDN `sip.retellai.com`, import number via API). [Retell Telnyx deploy docs](https://docs.retellai.com/deploy/telnyx)
- **Tool calling**: Custom Function tool, Retell POSTs to your backend URL with parameters, your server can hit Postgres directly, returns JSON, agent continues. [Function calling guide](https://www.sacesta.com/our-work/blog/complete-guide-retell-ai-function-calling-custom-tools)
- **Warm transfer**: supported for phone calls on Retell/imported numbers (human-detection, private message, three-way introduce). No Twilio-only restriction found. This is the safer managed-platform choice specifically because of the Telnyx-native deploy path plus working warm transfer.
  [Transfer call docs](https://docs.retellai.com/build/single-multi-prompt/transfer-call)

### Bland AI (for completeness, not recommended here)
- Shifted to tiered subscriptions: $0.11 to $0.14/min depending on plan tier ($0/$299/$499 per month), plus $0.015 per outbound attempt and a $0.03 to $0.05/min transfer surcharge unless BYOT (bring your own Twilio, not bring your own Telnyx). Routes calls through Twilio/SIP partners rather than owning the carrier stack, which cuts against an already-Telnyx setup.
  [Bland pricing 2026](https://www.lindy.ai/blog/bland-ai-pricing), [Telnyx vs Bland](https://telnyx.com/resources/bland-ai-alternatives)

- **Latency (both Vapi and Retell)**: an independent orchestration-layer benchmark puts median full-turn latency at about **2.46s** for Vapi (LiveKit similar), and about 3.15s for Pipecat/Synthflow, well above the sub-1s target unless the underlying LLM/STT/TTS choices are aggressively tuned (fast STT, small/fast LLM, streaming TTS). [LiveKit latency blog](https://livekit.com/blog/understand-and-improve-agent-latency), [Cekura benchmarks](https://benchmarks.cekura.ai/)
- **Barge-in**: handled out of the box on both platforms (VAD-based interruption is table stakes).
- **Build effort**: SIP trunk/number-import setup plus one webhook backend plus dashboard flow config plus transfer testing. Estimate **3 to 5 days**.

## 3. Self-hosted orchestration: LiveKit Agents (preferred over Pipecat)

- **Cost/min**: no platform fee for open-source LiveKit Agents; you pay STT, LLM, and TTS providers directly at cost (commonly estimated around $0.08 to $0.15/min for a fast stack, e.g. Deepgram plus GPT-4o-mini/Groq plus streaming TTS, **UNVERIFIED, stack-dependent**) plus Telnyx telephony (around $0.002 to $0.01/min) plus either your own compute hosting or LiveKit Cloud fees. Telnyx also now offers **"LiveKit on Telnyx"**, a hosted LiveKit deployment running on Telnyx's own carrier network with HD Voice (G.722/Opus); exact per-minute pricing for this hosted option was **not found**, flagged UNVERIFIED, needs a direct pricing-page check before committing.
  [LiveKit on Telnyx](https://telnyx.com/release-notes/livekit-on-telnyx-voice-ai-infrastructure), [HD Voice on LiveKit/Telnyx](https://telnyx.com/release-notes/hd-voice-livekit)
- **Latency**: LiveKit's own architecture streams every stage so perceived latency approaches `max(STT, LLM time-to-first-token, TTS time-to-first-byte)` rather than the sum; LLM time-to-first-token is typically 300 to 800ms. Best-case sub-1s is achievable with a tuned fast stack, but the same generic benchmark cited above puts LiveKit's default/untuned median around 2.46s, an engineering-effort-dependent outcome, not a guarantee out of the box.
  [LiveKit latency blog](https://livekit.com/blog/understand-and-improve-agent-latency)
- **Barge-in**: not zero-config, LiveKit ships a turn-detector plugin/model you wire in yourself; you own the interruption logic (cancel TTS playback on detected user speech).
- **Tool calling**: full control, in-process, register arbitrary Python functions as LLM tools, call Postgres directly (asyncpg/psycopg) with no network hop to a third-party platform. Lowest tool-call latency of any path since there's no external webhook round trip.
- **Warm transfer**: DIY, build it yourself on top of LiveKit SIP primitives or Telnyx Call Control (dial second leg, bridge/conference, drop AI leg). No packaged "warm transfer" feature.
- **Telnyx fit**: native via the "LiveKit on Telnyx" hosted offering, or self-host LiveKit plus a standard Telnyx SIP trunk, both are documented paths.
  [LiveKit SIP trunk setup](https://docs.livekit.io/telephony/start/sip-trunk-setup/), [Telnyx LiveKit docs](https://developers.telnyx.com/docs/livekit)
- **Recording**: LiveKit Egress (room/composite recording) alongside or instead of Telnyx's own call recording; the transcript is already produced by your own STT stage, so no separate transcription cost.
- **Build effort**: highest of all four, **LiveKit Agents is a Python-first framework**, a real mismatch for a Next.js/TypeScript-fluent team. Full production build (worker, provider wiring, turn detection tuning, SIP dispatch rules, tool functions, custom transfer logic, Egress recording, deployment): estimate **10 to 20 days**.

## 4. OpenAI Realtime API direct to Telnyx media streaming

- **Cost/min**: token-based. `gpt-realtime-2.1`: $32/$64 per 1M audio input/output tokens (mini: $10/$20). Works out to roughly **$0.18 to $0.46/min uncached**, **$0.05 to $0.10/min with prompt caching** (cached audio input $0.40/1M versus $32/1M). Plus Telnyx telephony (around $0.002 to $0.01/min). No separate STT/TTS cost since it's natively speech-to-speech.
  [HackerNoon pricing analysis](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions), [TokenMix](https://tokenmix.ai/blog/openai-realtime-voice-api-2026-cost-latency)
- **Latency**: single speech-to-speech model, no STT to LLM to TTS chain, generally the fewest hops of any path, sub-1s time-to-first-audio is realistic, though not independently benchmarked in what I found for this exact Telnyx-bridge architecture (**UNVERIFIED end-to-end over a live PSTN bridge**).
- **Barge-in**: native, server-side VAD (or semantic VAD) enabled by default, `interrupt_response: true` cancels the ongoing response on detected user speech, and the server auto-truncates unplayed audio on interruption. This is the most explicitly documented barge-in handling of any option.
  [Realtime VAD docs](https://platform.openai.com/docs/guides/realtime-vad)
- **Tool calling**: native function calling in the Realtime session config; your bridge server executes it in-process (same low-latency advantage as LiveKit, direct Postgres/HTTP access, no third-party webhook hop).
- **Warm transfer**: DIY, OpenAI has no telephony concept at all, it only sees an audio stream. You implement transfer entirely via Telnyx Call Control (dial a new leg to the human, bridge/conference the legs, drop the AI leg).
- **Telnyx fit**: Media Streaming over WebSockets, Telnyx forks the call's RTP audio (PCMU/PCM16/Opus) to your WebSocket server, which relays to/from the OpenAI Realtime WebSocket. Telnyx publishes a worked example for exactly this pattern.
  [Telnyx + OpenAI Realtime outbound calls tutorial](https://telnyx.com/resources/outbound-ai-calls-python-openai-realtime), [Telnyx media streaming](https://telnyx.com/resources/media-streaming-websocket)
- **Recording**: clean, Telnyx's own Call Control recording ($0.002/min) runs on the underlying call independent of the media-streaming fork; transcript can come from OpenAI Realtime's own transcript events instead of paying for separate STT.
- **Build effort**: medium, this is the only "build it yourself" path that stays entirely in Node/TypeScript (WebSocket relay server, OpenAI Realtime WS client, Telnyx Call Control API calls for transfer/recording), no Python voice framework required. Estimate **5 to 9 days**.

## Keeping tool-call latency out of the conversation (current standard practice, 2026)

- **Filler phrases**: have the agent say a short natural filler ("let me check that for you") the instant a tool call fires, doesn't reduce real latency but hides it from the caller; standard on every platform above.
- **Prefetch on high-confidence partial intent**: fire the tool call in parallel with the LLM turn as soon as STT partial-transcript confidence crosses a threshold (commonly cited around 0.85), then cancel the prefetch if a later partial changes the detected intent. Saves roughly 200 to 400ms versus waiting for the full LLM decision to trigger the call.
- **Cached read models and warm connections**: keep hot DB connections and cached lookups (materialized views for order/invoice status) so the tool call itself resolves in tens of milliseconds rather than hitting cold Postgres or a cold third-party API; pre-warm model/provider connections so the first turn of a session isn't paying a cold-start tax.
- Track prefetch-fired versus prefetch-cancelled as a metric; a success rate above 90% is the bar cited for the technique paying off.
  [Voice agent latency optimization, ElevenLabs](https://elevenlabs.io/blog/voice-agent-latency-optimization), [12 techniques 2026](https://futureagi.com/blog/how-to-optimize-voice-agent-latency-2026/)

## Recommendation

**Telnyx native AI Assistant.** It is the only path that natively satisfies every hard requirement (warm transfer, tool-call webhooks, call recording, single vendor already in place) with the least build effort (2 to 4 days, config plus one webhook backend, no telephony integration to build at all). Escalate to **Retell AI over a Telnyx SIP trunk** (not Vapi, since its warm transfer is documented Twilio-only) only if live testing shows Telnyx's built-in LLM/webhook-tool latency or model flexibility is inadequate.
