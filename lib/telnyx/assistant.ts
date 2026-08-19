/**
 * The assistant, defined here rather than clicked into Mission Control.
 *
 * Every field name below was read off Telnyx's live docs on 2026-07-28, not
 * recalled. See AGENTS.md for the list and for the one field a plan asserted
 * that does not exist. The shape returned here IS the request body, so there is
 * no mapping layer between what the tests pin and what the API receives.
 *
 * Two settings do most of the work of not sounding like a phone tree:
 *
 *  - `transcription.model` is Deepgram Flux, a turn-taking model that does
 *    recognition and end-of-turn in one pass. There is no separate VAD to
 *    misfire, which is why no endpointing plan is set alongside it: that plan is
 *    documented for non turn-taking models and would be inert here.
 *  - `interruption_settings.start_speaking_plan.wait_seconds` is the pause
 *    before the agent takes its turn. The default is 0.4. A receptionist comes
 *    back faster than that, so this is 0.3, and Task 14's eval is what says
 *    whether 0.3 cuts real callers off.
 */
// Explicit .ts extensions: scripts/assistant-sync.mts imports this module and
// runs under node directly, whose ESM resolver will not guess an extension.
// Both of these are leaf modules, so the convention stops here.
import { optionalEnv } from '../env.ts';
import { keyterms, systemPrompt } from '../agent/brief.ts';

/** The six tools, in the order the prompt introduces them. */
export const TOOL_NAMES = [
  'lookup_invoice',
  'check_order',
  'text_me_the_list',
  'take_message',
  'offer_human',
  'escalate_to_human',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The one voice on this phone line.
 *
 * It lives here rather than in client.ts because this is the file that documents
 * the `<Provider>.<Model>.<VoiceId>` rule, and both consumers import it: the
 * assistant's `voice_settings.voice`, and the Call Control `speak` command that
 * reads the recording disclosure before the assistant ever starts.
 *
 * They used to be two separate variables with two separate defaults, and the
 * disclosure default was `female`, Telnyx's legacy BASIC engine. A caller heard
 * a robot read a legal notice and then a different, human-sounding person say
 * hello. One function, one default, so they cannot drift apart again.
 *
 * WHY THIS IS NOT BAYAN ANY MORE (2026-08-14)
 *
 * `Telnyx.Bayan` is Telnyx's ARABIC model: 113 speakers across 13 Arabic
 * dialects, a handful of English speakers bolted on the side, 16kHz native, and
 * four English female voices out of 4494. It ran this line from day one because
 * the 2026-07-28 bake-off had six candidates and three of them were Bayan, so
 * Amanda won a race with only one kind of runner in it.
 *
 * Karim, off a test call on 2026-08-14: "there was no understanding of commas
 * or punctuation, it was just like one straight sentence... if I didn't know
 * Akme I don't think I would have understood a word of what she was saying."
 * Phrasing English at clause boundaries is the thing an Arabic-first model is
 * not tuned to do.
 *
 * Rerun sheet, eight candidates including Amanda as the control, rendered on
 * the real opener and band-limited to 8kHz mu-law. Karim picked
 * `Telnyx.Natural.abbie` by ear.
 *
 * AND THAT PICK LASTED ONE CALL, for a reason worth writing down. abbie is a
 * fast talker: her natural opener is 5.23s against the 7.40s Karim approved, so
 * running her meant a 30 percent stretch. Karim, hours later: "the tone is not
 * professional at all... so down-pitched, as if the voice were slowed down." Pitch was
 * measured and is innocent, median F0 246Hz at 1.0 against 258Hz at 0.70, so
 * nothing is being resampled. What a 30 percent stretch changes is duration
 * alone, and a drawl IS duration alone.
 *
 * THE RULE THAT COMES OUT OF IT: pick a voice whose NATURAL pace is right,
 * never a voice you have to fight with a multiplier. The sheet had been
 * rendering every candidate at one shared speed, which quietly made it a test of
 * two things at once, so abbie won partly on how well she survived stretching.
 *
 * `Telnyx.NaturalHD.luna` runs the opener in 7.60s at 1.0, against a 7.40s
 * target. It is the only candidate that needs no stretch at all. Rime Arcana
 * underneath: English-first, 24kHz native, the quality tier rather than the
 * low-latency one, which is the right trade when the complaint is that a caller
 * cannot follow us.
 *
 * CONFIRMED BY EAR the same day, on the band-limited sheet: Karim picked luna
 * and `Telnyx.NaturalHD.astra` over the rest, both Rime Arcana, which is the
 * useful part of the result. The model was the thing that mattered, not the
 * speaker. astra is the runner-up and is one env var away, 8.61s natural, a
 * shade slower than target; try it before reopening the whole sheet.
 */
/**
 * NaturalHD IS UNLISTED, NOT DELETED, and the difference cost a day.
 *
 * On 2026-08-18 a sync failed with 400 "Voice `Telnyx.NaturalHD.luna` not
 * found", and `GET /v2/text-to-speech/voices` did not carry NaturalHD among its
 * models. The conclusion drawn was that Telnyx had deleted the tier, so this
 * default was changed to an Ultra voice picked by reasoning rather than by ear.
 *
 * Every part of that was wrong except the 400:
 *
 *  - luna and astra still RENDER through `POST /v2/text-to-speech/speech`.
 *    Both were rendered on 2026-08-19 to check.
 *  - The assistant accepted `Telnyx.NaturalHD.luna` again on 2026-08-19, read
 *    back by `pnpm assistant:sync`. The rejection was transient.
 *  - The line was never running on a fallback. The assistant's version history
 *    stores luna on every version from 20260815T074209 to 20260815T183024, so
 *    luna is what actually answered the phone through the 15th and 16th.
 *
 * So the voice Karim picked by ear on 2026-08-14 was replaced with one he never
 * heard, on the strength of a transient error, and he noticed on the first call:
 * "you broke something, the voice isnt the same". This is that, put back.
 *
 * THE LESSON, WHICH IS THE PART WORTH KEEPING: a 400 from this API is evidence
 * about one request, not about the state of the world. Absence from the voices
 * list is not deletion either, because the list and the renderer disagree. Check
 * a voice by RENDERING it before concluding it is gone, and never replace a
 * choice Karim made by ear on inference alone.
 *
 * It can still go away for real, so preflight now warns when the configured
 * voice is missing from the published list. The disclosure is safe either way:
 * it is a pre-rendered file now, and a file cannot stop existing because a voice
 * was retired. See opener.ts.
 *
 * KATIE, FROM 2026-08-19, AND THIS ONE IS KARIM'S EAR. He found her in Telnyx's
 * TTS Playground, heard her on his own text, and said "I want this voice". That
 * is the same way Amanda, abbie and luna were each chosen, and the only way that
 * has ever held up: every voice picked here by reasoning has been overturned by
 * him listening, most recently four days ago.
 *
 * MORGAN, FROM LATER THE SAME DAY, and the same ear picked her. Karim heard
 * Katie on a real call and moved to `Telnyx.Ultra.0ee8beaa-db49-4024-940d-c7ea09b590b3`,
 * "Morgan - Executive Expert", described by Telnyx as a polished American female
 * for highly professional interactions. On an inbound BUSINESS support line that
 * is the register the notes above kept reaching for and missing: Katie is a
 * friendly fixer, Morgan answers a company's phone.
 *
 * Both are Ultra and both are published in `GET /v2/text-to-speech/voices`,
 * unlike luna, so the preflight check that warns about an unlisted voice goes
 * quiet on either one.
 *
 * Speed stays at 1, per the rule the notes above earned twice: pick a voice whose
 * natural pace is right instead of fighting one with a multiplier. A number far
 * from 1 here means the wrong voice was picked, not that the pace needs work.
 *
 * Ultra also understands inline `<emotion value="..." />` markup and cues like
 * [laughter], which luna did not. Unused so far, and worth remembering the next
 * time the complaint is tone rather than speed.
 */
export function agentVoice(): string {
  return optionalEnv('TELNYX_TTS', 'Telnyx.Ultra.0ee8beaa-db49-4024-940d-c7ea09b590b3');
}

/**
 * How fast Robin talks. 1 is the voice's natural pace, below 1 is slower.
 *
 * Down from 1 on Karim's read of a real call (2026-08-03): understandable, but
 * enough faster than a person that a caller has to work to keep up, and a phone
 * line is the one place you cannot ask someone to rewind.
 *
 * Down again to 0.85 on 2026-08-11, same complaint a second time: "it seems to
 * be rushing through its speech". Worth being honest that most of that is
 * probably not this number. A model that answers in one long comma-spliced
 * breath sounds rushed at any speed, which is why the turn-shape rules landed in
 * the same pass (one to three sentences, no chained clauses). This is the
 * smaller half of the fix and the easier one to undo: if 0.85 now sounds slow,
 * put it back to 0.9 in .env.local and keep the prompt change.
 *
 * THIS NUMBER IS PER VOICE, NOT ABSOLUTE, which is the trap that came with
 * changing the voice on 2026-08-14. It is a multiplier on a pace each voice
 * sets for itself, so the same 0.85 is a different speaking rate on every
 * voice. Measured on the real opener, band-limited to 8kHz: Amanda at 0.85
 * takes 7.40s and abbie at 0.85 takes 6.44s. Karim's complaint was the opener
 * arriving in 5.85s, so shipping the new voice at the old number would have
 * handed back most of the fix while every config file said it was still
 * applied. 0.70 puts abbie at 7.22s, which is the pace he approved.
 *
 * So: RE-MEASURE THIS WHENEVER THE VOICE CHANGES. Render the opener at a few
 * values, band-limit it, and pick by duration rather than by keeping the number
 * that worked for a different voice.
 *
 * BACK TO 1 ON 2026-08-14, and the number moving back to its default is the
 * point rather than a coincidence. A big stretch is audible: abbie at 0.70 drew
 * "so down-pitched, as if the voice were slowed down" out of Karim, with the pitch
 * measured flat, so what he heard was duration. The voice was then chosen for
 * having the right pace ALREADY, and luna runs 7.60s against a 7.40s target at
 * 1.0. A number far from 1 here now means the wrong voice was picked, not that
 * the pace needs work: treat it as a smell, and change the voice instead.
 *
 * `voice_speed` is undocumented, like `interrupt_prediction_threshold`, so a 200
 * from Telnyx proves nothing here, and `pnpm assistant:sync` reading it back
 * only proves it was STORED. It has to be nested under `voice_settings`: sent
 * at the top level it is accepted and silently ignored, measured 2026-08-14 at
 * 6.4s against a 6.7-7.4s baseline, where the same number nested gave 15.1s.
 * Env-overridable because pace is a taste knob and finding the right one should
 * not need a code change; the clamp is there so a typo in .env.local cannot put
 * NaN in the request and fail the sync with a message about some other field.
 */
export function voiceSpeed(): number {
  const parsed = Number(optionalEnv('TELNYX_VOICE_SPEED', '1'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export interface WebhookTool {
  type: 'webhook';
  webhook: {
    name: ToolName;
    description: string;
    url: string;
    method: 'POST';
    headers: { name: string; value: string }[];
    body_parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export interface AssistantConfig {
  name: string;
  model: string;
  /**
   * Route the model call through our own gateway instead of calling Telnyx's
   * model directly. Omitted entirely unless configured, so an unset env var is
   * the old behaviour rather than a half-applied one.
   *
   * `base_url` is ours and Telnyx appends `/chat/completions`. `model` is what
   * Telnyx puts in the request body, which the gateway overrides from its own
   * env, so the model lives in one place and rolling it back is an env var
   * rather than an assistant write.
   *
   * `llm_api_key_ref` IS THE INTEGRATION SECRET'S `identifier`, NOT ITS UUID,
   * and the docs call it `integration_secret_id` which is what sends you the
   * wrong way. Passing the UUID returns 400 "External LLM API key (integration
   * secrets) <uuid> not found", which reads like the secret does not exist when
   * it does. Learned the expensive way on 2026-08-15.
   */
  external_llm?: {
    base_url: string;
    llm_api_key_ref: string;
    model: string;
  };
  instructions: string;
  greeting: string;
  transcription: {
    model: string;
    settings: {
      keyterm: string;
      /** 0.5-0.9. Confidence needed to call a turn finished. */
      eot_threshold: number;
      /** 500-10000. Silence that forces a turn to end. */
      eot_timeout_ms: number;
      /** 0.3-0.9, and must be <= eot_threshold. See the comment at the value. */
      eager_eot_threshold: number;
    };
  };
  interruption_settings: {
    enable: boolean;
    disable_greeting_interruption: boolean;
    interrupt_prediction_threshold: number;
    start_speaking_plan: { wait_seconds: number };
  };
  telephony_settings: {
    noise_suppression: 'krisp' | 'deepfilternet' | 'disabled';
    /**
     * Undocumented, like interrupt_prediction_threshold, and both are read back
     * by assistant-sync so a field Telnyx drops fails the sync instead of going
     * quiet. Written at their current values rather than changed: neither has
     * any evidence against it, and the point of naming them here is that they
     * stop being whatever Telnyx defaults to next.
     */
    time_limit_secs: number;
    user_idle_reply_secs: number;
    /**
     * The assistant records the call itself unless told not to, and `enabled`
     * DEFAULTS TO TRUE. We already run our own dual-channel `record_start` from
     * the disclosure step, so leaving this alone produced two recordings of
     * every call and two `call.recording.saved` webhooks. There is no per-call
     * override for it; it is only settable on the stored assistant.
     */
    recording_settings: { enabled: boolean };
  };
  /**
   * Voice is nested here, not top level. A top-level `voice` is accepted with a
   * 200 and silently ignored, which is how this shipped voiceless once.
   */
  voice_settings: {
    voice: string;
    /** Also undocumented. 1 is the voice's natural pace; see voiceSpeed(). */
    voice_speed: number;
    background_audio: { type: 'predefined_media'; value: string; volume: number };
  };
  tools: WebhookTool[];
  dynamic_variables_webhook_url: string;
  dynamic_variables_webhook_timeout_ms: number;
}

export interface AssistantConfigDeps {
  /** Public origin Telnyx can reach: the tunnel in dev, the deployment in prod. */
  publicBaseUrl: string;
  /** Shared secret every tool call and context call must present back to us. */
  toolSecret: string;
}

interface ToolSpec {
  name: ToolName;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

/**
 * A webhook tool call arrives carrying only the arguments the model filled in.
 * Telnyx sends no call_control_id, no conversation id, and no caller identity
 * with it, so the only way a tool can act on the right call is for the caller's
 * number to be one of those arguments.
 *
 * The prompt tells the agent to pass `{{telnyx_end_user_target}}` verbatim, and
 * the server resolves it against the call it bound at conversation start. Every
 * tool takes it, including the ones that could technically work without it,
 * because a tool that sometimes needs it and sometimes does not is a tool the
 * model gets wrong half the time.
 */
const CALLER_PHONE = {
  caller_phone: {
    type: 'string',
    description:
      'The number the caller is calling from, in E.164. Always pass the value of telnyx_end_user_target exactly as given to you.',
  },
} as const;

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'lookup_invoice',
    description:
      'Look up one invoice by its number and return whether it is paid. Use only when the caller says an invoice number.',
    properties: {
      ...CALLER_PHONE,
      invoice_number: { type: 'string', description: 'The invoice number the caller said, digits only.' },
    },
    required: ['caller_phone', 'invoice_number'],
  },
  {
    name: 'check_order',
    description: "Look up the caller's most recent order and what is on it.",
    properties: { ...CALLER_PHONE },
    required: ['caller_phone'],
  },
  {
    name: 'text_me_the_list',
    description:
      // Deliberately NOT "asks what we stock" any more. The agent now answers that
      // out loud from the brief, in one sentence of product names, and texting the
      // list instead of answering a question it can answer is worse service.
      'Text the caller our product list and how to get a quote, and put their request in front of the team. Use when the caller wants pricing, wants to order, or asks for something in writing.',
    properties: {
      ...CALLER_PHONE,
      wants: {
        type: 'string',
        description:
          'What the caller said they need, in their own words. Use "the full product list" if they did not name anything.',
      },
      caller_name: { type: 'string', description: 'The caller name, if they gave one.' },
    },
    required: ['caller_phone', 'wants'],
  },
  {
    name: 'take_message',
    description:
      // NOT "use at the end of any call" any more, which is what it said until
      // 2026-08-11. A rehearsal caller who asked for a message, said what it was
      // about and read out a callback number got asked their name twice and the
      // message was never filed. The system prompt says not to stall on an
      // optional field, and it lost: for a tool-calling decision the tool's own
      // description is the closer authority, so "at the end" beat it. The rule
      // this is an instance of: a tool description is prompt, and a rule stated
      // in only one of the two is a rule the model gets to choose between.
      'Save a message for the team and send it to them. Call this as soon as you know what the caller wants and have a number to reach them on. Do not wait for the end of the call, and do not wait for a name: caller_name is optional and a message without one is complete.',
    properties: {
      ...CALLER_PHONE,
      message: { type: 'string', description: 'What the caller wants, in one or two sentences.' },
      callback_number: {
        type: 'string',
        description: 'The number to call back, confirmed out loud with the caller first.',
      },
      caller_name: { type: 'string', description: 'The caller name, if they gave one.' },
    },
    required: ['caller_phone', 'message', 'callback_number'],
  },
  {
    name: 'offer_human',
    description:
      // The tool that exists because the OTHER one used to do this job badly.
      // Until 2026-08-15 `escalate_to_human` said to fire "when they are upset or
      // disputing a charge", so a caller who mentioned a damaged delivery was
      // dialled through mid-sentence, having been asked "would you like that?"
      // and never given room to answer. Judgment now gets its own tool, and that
      // tool cannot dial. See the note above `escalate_to_human`.
      // The second sentence about the yes is not padding. In rehearsal the agent
      // offered, the caller said "yes please", and it answered "One moment." and
      // called nothing, leaving them holding a line nobody was ringing. An offer
      // that cannot be completed is a worse failure than the one this tool was
      // built to stop, so the follow-through is spelled out where the decision
      // is made.
      'Ask the caller whether they would like to be put through to a person, and wait for their answer. This only ASKS: it never connects anyone, so it is always safe. Use it whenever you think a person would help but the caller has not asked for one: they are upset, disputing a charge or an amount, changing or cancelling an order, pushing for pricing you cannot give, or your answer has not landed twice. If they then say yes, you MUST call escalate_to_human with trigger "accepted": that is the only thing that connects anybody, and saying "one moment" on its own rings nobody.',
    properties: {
      ...CALLER_PHONE,
      reason: { type: 'string', description: 'Why you think they need a person, in a few words.' },
    },
    required: ['caller_phone', 'reason'],
  },
  {
    name: 'escalate_to_human',
    description:
      // NOT "or when they are upset or disputing a charge" any more. That clause
      // contradicted the system prompt, which said to offer first and dial on a
      // yes, and the tool description won: same failure shape as `take_message`
      // and "use at the end of any call" on 2026-08-11. A rule stated in only one
      // of the two places is a rule the model gets to choose between, so the two
      // now say the same thing, and `trigger` makes the model name which case it
      // believes it is in rather than blur them.
      'Ring the team and connect the caller to a person. Only two things may lead here: the caller asked for a person in their own words, or they said yes to an offer you already made with offer_human on an earlier turn. Never call this on your own reading of the situation, and never in the same turn as the offer: if you are asking, use offer_human and wait.',
    properties: {
      ...CALLER_PHONE,
      reason: { type: 'string', description: 'Why the caller needs a person, in a few words.' },
      // A plain string rather than a JSON Schema enum: Telnyx documents
      // body_parameters loosely and an unverified field is how a sync starts
      // failing. It costs nothing to leave it open, because the server treats
      // anything that is not exactly "asked" as "accepted" and then demands the
      // offer on record. An unrecognised value therefore fails closed.
      trigger: {
        type: 'string',
        description:
          'Exactly one of: "asked" if the caller asked for a person in their own words, or "accepted" if they said yes to an offer you made with offer_human on an earlier turn.',
      },
    },
    required: ['caller_phone', 'reason', 'trigger'],
  },
];

export function assistantConfig(deps: AssistantConfigDeps): AssistantConfig {
  const tools: WebhookTool[] = TOOL_SPECS.map((spec) => ({
    type: 'webhook',
    webhook: {
      name: spec.name,
      description: spec.description,
      url: `${deps.publicBaseUrl}/api/agent/tools/${spec.name}`,
      method: 'POST',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Agent-Secret', value: deps.toolSecret },
      ],
      body_parameters: {
        type: 'object',
        properties: spec.properties,
        required: spec.required,
      },
    },
  }));

  // The gateway is opt-in and both halves must be present, because half of it is
  // an assistant that points somewhere it cannot authenticate to.
  const gatewayBase = process.env.TELNYX_EXTERNAL_LLM_BASE_URL?.trim();
  const gatewayKeyRef = process.env.TELNYX_EXTERNAL_LLM_KEY_REF?.trim();
  const gateway =
    gatewayBase && gatewayKeyRef
      ? {
          base_url: gatewayBase,
          llm_api_key_ref: gatewayKeyRef,
          model: optionalEnv('LLM_PROXY_MODEL', 'MiniMaxAI/MiniMax-M3-MXFP8'),
        }
      : undefined;

  return {
    name: 'Akme line',
    // Latency is the product on a phone line, so this defaults to a native
    // Telnyx-hosted model with no external hop. NEAR AI Cloud stays the default
    // everywhere latency is free (summaries, SMS drafting) and Task 11 measures
    // it here as a custom LLM before this default changes.
    //
    // EMPTY STRING WHEN THE GATEWAY IS ON, AND THAT IS THE ONLY WAY TO SET ONE.
    // Telnyx rejects an assistant carrying both: "Assistant can not have both
    // model and external_llm set". `null` does NOT clear it (the stored value
    // survives and the same 400 comes back) and neither does omitting the field,
    // because this is a PATCH. `''` is what clears it, and clearing it alone is
    // also refused, so the clear and the external_llm must land in one request.
    //
    // There is therefore NO Telnyx-level model fallback: it is one or the other.
    // The only fallback is the one inside the gateway itself, which is why that
    // route falls back to Haiku on its own rather than relying on this field.
    model: gateway ? '' : optionalEnv('TELNYX_LLM_MODEL', 'anthropic/claude-haiku-4-5'),
    ...(gateway ? { external_llm: gateway } : {}),
    instructions: systemPrompt(),

    // EMPTY ON PURPOSE, AND THIS IS THE FIELD THAT BROKE THE LINE.
    //
    // The opener is one pre-rendered file that already ends by asking the
    // question (see openerText in opener.ts), and the agent is started while
    // that file is still playing so it boots behind the audio instead of after
    // it. The start command therefore sends `greeting: ''`, documented as "if
    // none then nothing will be played when the assistant starts".
    //
    // TELNYX DOES NOT HONOUR THAT. An empty string reads as absent, the stored
    // greeting is used as the fallback for any omitted field, and the stored
    // greeting was this one. Measured on Karim's call of 2026-08-19 20:07, from
    // telnyx_events and GET /v2/ai/conversations/{id}/messages:
    //
    //   +2.18s  call.playback.started      the disclosure begins
    //   +3.13s  call.conversation.created
    //   +3.78s  assistant speaks "How can I help you today?"   <- over the notice
    //   +9.92s  call.playback.ended        the file asks it a second time
    //   +21.4s  hangup, after 11s of silence, nothing said by either side
    //
    // So the caller heard two voices at once a second and a half into a legal
    // notice, then the same question twice. Karim: "the phone line is broken a
    // little... maybe the disclaimer should be here with hi how can I help you
    // today at the end so there is no mess."
    //
    // Clearing it here is what makes the per-call override real: with nothing
    // stored there is nothing to fall back TO, on any path, including one that
    // forgets to send the override. Same lesson as the model field above and as
    // `take_message` and `escalate_to_human` before it: a request the API is
    // free to ignore is not a guarantee, so the guarantee has to be stored.
    //
    // GREETING itself is NOT dead. It is the last sentence of the rendered
    // opener and it is quoted to the model in the prompt, so the agent knows the
    // question has already been asked. It just is not spoken by the assistant.
    greeting: '',
    transcription: {
      model: optionalEnv('TELNYX_STT', 'deepgram/flux'),
      settings: {
        // Comma-separated string, not an array. Same terms the post-call
        // transcript boosts, from the same function, so the two cannot drift.
        keyterm: keyterms().join(','),

        // Left at the Portal default. Lowering it makes the agent commit to a
        // turn ending sooner, which is how you start talking over people, and
        // nothing on a real call has argued for it.
        eot_threshold: 0.8,

        // Down from the 5000 default. This is the silence that forces a turn to
        // end when Flux never gets confident, i.e. exactly the caller who trails
        // off mid-sentence. Five seconds of that reads as a dropped line.
        eot_timeout_ms: 3000,

        // The one that was actually broken. This was sitting at 0.8, equal to
        // eot_threshold, because nothing here ever set it and that is what the
        // API stores by default. Telnyx documents what that means: "Setting both
        // thresholds to the same value effectively disables eager end-of-turn
        // behavior because the system waits for final end-of-turn confirmation
        // before starting LLM processing." So the whole point of running Flux,
        // starting the model early on a speculative end of turn, was off. 0.4 is
        // the Portal default and the value in Telnyx's own example. Speculation
        // that turns out wrong is discarded, so this cannot cut a caller off:
        // the real commit still needs 0.8.
        eager_eot_threshold: 0.4,
      },
    },
    interruption_settings: {
      enable: true,
      // This was false, on the theory that a caller talking over a one-line
      // greeting is telling us what they want. On real calls it was line noise
      // doing the talking: the agent's first sentence on a 58 second call was
      // "I'm not sure I caught that", before the caller had said a word. The
      // greeting is under two seconds. Nobody is kept waiting by protecting it,
      // and `enable: true` above still lets them cut in from then on.
      disable_greeting_interruption: true,
      // Undocumented but real: it is absent from the published docs and the API
      // stores it, defaulting to 0.0, which means off. At 0.4 a caller saying
      // "mm-hm" while the agent talks no longer cuts it off, while a genuine
      // interruption still lands. Read back by assistant-sync, so if Telnyx ever
      // drops the field the sync says so instead of going quiet.
      interrupt_prediction_threshold: 0.4,
      // Down from 0.3, on the Flux guidance: "Flux works best with low start
      // speaking delays, such as 0.1 seconds for wait time". 0.3 was picked as
      // simply-below-the-0.4-default, before the model was Flux.
      start_speaking_plan: { wait_seconds: 0.1 },
    },
    telephony_settings: {
      noise_suppression: 'krisp',
      // Both unchanged, both now ours rather than Telnyx's. 30 minutes is a
      // runaway guard, not a target, and a real call is with a human long before
      // it. 10 seconds of silence before the agent speaks up is the difference
      // between patient and pushy while somebody looks up an address.
      time_limit_secs: 1800,
      user_idle_reply_secs: 10,
      // Off, because our own record_start already covers the whole call. See the
      // field comment above: this defaults to TRUE and was the second recording.
      recording_settings: { enabled: false },
    },
    voice_settings: {
      // Set by the bake-off in Task 6, and shared with the Call Control `speak`
      // that reads the disclosure, so the caller hears one person start to
      // finish. Format is <Provider>.<Model>.<VoiceId>, and the id must exist in
      // GET /v2/text-to-speech/voices.
      voice: agentVoice(),
      voice_speed: voiceSpeed(),
      // "office" room tone was here so a pause during a tool call did not read as
      // a dropped line. On a real call it read as murmuring instead: Karim heard
      // the agent as full of "uhmms", and office ambience is chatter. The trade
      // has also moved, because the common path (products, then route to a quote)
      // makes no slow tool calls, so there is barely a pause left to cover. Set
      // TELNYX_BACKGROUND_AUDIO back to "office" to restore it; tenths only, 0.35
      // is a 400 rather than a rounding.
      background_audio: {
        type: 'predefined_media',
        value: optionalEnv('TELNYX_BACKGROUND_AUDIO', 'silence'),
        volume: 0.3,
      },
    },
    tools,
    dynamic_variables_webhook_url: `${deps.publicBaseUrl}/api/agent/context`,
    // The assistant will not say a word until this webhook answers or this
    // timeout expires, so it is a ceiling on how long the caller sits in silence
    // after the disclosure. It was 8000, then 2500 on the reasoning that the
    // lookup is ~200ms and is prewarmed at call.answered, so the ceiling would
    // never be reached.
    //
    // DOWN TO 1200 ON 2026-08-18, because that reasoning had a hole in it. The
    // prewarm caches in the process that handles /api/voice, and Telnyx posts
    // this webhook to /api/agent/context, which on Vercel is a different
    // function with its own cold start. So the prewarm hits in `next dev` and
    // misses in production, and the ceiling was being reached by exactly the
    // calls Karim heard as dead air: "not wait like 7 seconds", 2026-08-18.
    // warmCallerContextRoute now boots that function during the disclosure, and
    // this caps what a boot that still runs long can cost the caller.
    //
    // The trade is that a lookup slower than 1.2s greets a regular customer as a
    // stranger. That costs one line of recognition. Waiting costs the opening of
    // the call, which is the thing being complained about, so the cap wins.
    dynamic_variables_webhook_timeout_ms: 1200,
  };
}
