/**
 * Drive the real prompt through the real model with scripted callers, and score it.
 *
 * WHAT THIS IS NOT: proof that the phone line sounds good. It cannot hear the
 * voice, it cannot be talked over, and it never touches Telnyx voice. A passing
 * rehearsal is not a passing system, which is why this is called `rehearse` and
 * not `eval`. Task 14's `eval` is the real-call harness that places outbound legs
 * and costs about $2 a run; this is the gate you clear BEFORE spending that.
 *
 * WHAT IT IS: every behaviour rule in the prompt, checked mechanically, for about
 * a cent. It uses the same `systemPrompt()`, the same `GREETING`, the same tool
 * names and descriptions from `assistantConfig()`, and the same model id the
 * assistant runs, over Telnyx's OpenAI-compatible chat completions endpoint. No
 * second copy of any of it, so a prompt edit is scored by this on the next run.
 *
 * Model choice: this deliberately does NOT go through NEAR AI Cloud, which is the
 * default everywhere else. The point is to score the exact model that answers the
 * phone, and that model is Telnyx-hosted.
 *
 * The scenarios are not invented. Scenario 1 is a transcript of a real 58 second
 * call on 2026-07-29 where the caller said "I'd like to place an order" three
 * times and got asked what kind of tape. Every other scenario pins one rule that
 * was either broken on a real call or that Karim named directly.
 *
 *   pnpm rehearse            all scenarios
 *   pnpm rehearse order      only scenarios whose name contains "order"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { GREETING, systemPrompt } from '../lib/agent/brief.ts';
import { assistantConfig } from '../lib/telnyx/assistant.ts';

const API = 'https://api.telnyx.com/v2/ai/chat/completions';
const MODEL = process.env.TELNYX_LLM_MODEL?.trim() || 'anthropic/claude-haiku-4-5';
const KEY = process.env.TELNYX_API_KEY?.trim();

if (!KEY) {
  console.error('TELNYX_API_KEY is missing. Run this through pnpm rehearse, which loads .env.local.');
  process.exit(1);
}

/**
 * The assistant's webhook tools, in the shape chat completions wants.
 *
 * Read off `assistantConfig()` rather than redeclared, so a tool renamed or
 * redescribed in the assistant is renamed and redescribed here for free. The urls
 * and the secret are throwaway: nothing here ever calls a tool for real.
 */
const TOOLS = assistantConfig({ publicBaseUrl: 'https://rehearsal.invalid', toolSecret: 'rehearsal' }).tools.map(
  (t) => ({
    type: 'function' as const,
    function: { name: t.webhook.name, description: t.webhook.description, parameters: t.webhook.body_parameters },
  }),
);

/**
 * What a tool hands back mid-conversation.
 *
 * Deliberately vague and deliberately NOT the real sentences from
 * lib/agent/tools.ts. Importing that module would drag in Supabase and Telnyx
 * clients, and the thing under test is what the AGENT says, never what the tool
 * says. A tool result here only has to be plausible enough for the conversation
 * to carry on to the next caller turn.
 */
const TOOL_RESULT: Record<string, string> = {
  escalate_to_human: 'Ringing the team now.',
  text_me_the_list: 'Sent, and the request is on the team queue.',
  take_message: 'Saved for the team.',
  lookup_invoice: 'That invoice is still open.',
  check_order: 'No recent order on this number.',
};

interface Turn {
  role: 'system' | 'assistant' | 'user' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface Transcript {
  /** Everything the agent said out loud, in order, greeting excluded. */
  said: string[];
  /** Tool names in call order, including repeats. */
  called: string[];
  /** The whole thing, for printing when a check fails. */
  turns: Turn[];
}

type Check = (t: Transcript) => string | null;

interface Scenario {
  name: string;
  why: string;
  /** Caller turns, in order. The agent's greeting is already on the wire. */
  caller: string[];
  checks: Check[];
}

// ---------------------------------------------------------------------------
// Check helpers. Each returns null on pass, or the reason it failed.
// ---------------------------------------------------------------------------

const all = (t: Transcript) => t.said.join(' ‖ ');

const mustSay = (re: RegExp, label: string): Check => (t) =>
  re.test(all(t)) ? null : `never said ${label}`;

const mustNotSay = (re: RegExp, label: string): Check => (t) => {
  const hit = t.said.find((s) => re.test(s));
  return hit ? `said ${label}: "${hit.trim()}"` : null;
};

const mustCall = (name: string): Check => (t) =>
  t.called.includes(name) ? null : `never called ${name} (called: ${t.called.join(', ') || 'nothing'})`;

/** A route is any of the three places a quote actually happens. */
const ROUTE = /akme\s*u\.?\s*s\.?\s*a\.?\s*(dot|\.)\s*com|akmeusa\.com|text (you|it|over)|i (can|will) text|email/i;

/** Money in any form the agent might produce it. */
const MONEY = /\$|\bdollars?\b|\bcents\b|\bper (case|roll|bundle|pallet) is\b|\bcosts? (about|around|roughly)? ?\d/i;

/** Order-taker behaviour: the failure this whole pass exists to kill. */
const ORDER_TAKING =
  /what else|anything else|how many (do you|would you|cases|rolls|bundles)|how much do you need|what quantit|add(ing)? that to|put(ting)? (that|you) down for/i;

/** Reciting measurements at somebody who asked what we sell. */
const MEASUREMENT = /\b\d+\s*(inch|inches|mm|millimet|yard|yd|feet|ft|gauge|ga\b|mil\b|pound|lb)/i;

/** Routing has to happen fast, not eventually. */
const routesBy = (turn: number): Check => (t) => {
  const early = t.said.slice(0, turn).join(' ');
  return ROUTE.test(early) ? null : `did not offer the website, a text or email within ${turn} turn(s)`;
};

/** Counts open "so what do you want" questions. The greeting already asked once. */
const REASK = /how (can|may) i help|what can i (do|get) for you|what do you need|what are you looking for|what can i help/i;
const asksWhatTheyNeedAtMost = (n: number): Check => (t) => {
  const hits = t.said.filter((s) => REASK.test(s));
  return hits.length <= n
    ? null
    : `asked what they need ${hits.length} times, cap is ${n}: ${hits.map((h) => `"${h.trim()}"`).join(' / ')}`;
};

// ---------------------------------------------------------------------------
// The scenarios.
// ---------------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  {
    name: 'order-intent-replay',
    why: 'The real 2026-07-29 call: three "I want to order" and it never mentioned a route.',
    caller: ["I'd like to place an order.", "I'm looking for tape and a couple other things.", 'Hot melt tape.'],
    checks: [
      routesBy(2),
      mustNotSay(ORDER_TAKING, 'order-taker filler'),
      mustNotSay(MONEY, 'a price'),
      asksWhatTheyNeedAtMost(0),
    ],
  },
  {
    name: 'order-with-a-list',
    why: 'A caller who reels off items must get the route, not an interrogation.',
    caller: ['I need four cases of clear tape and a pallet of the machine film. What is that going to run me?'],
    checks: [routesBy(1), mustNotSay(MONEY, 'a price'), mustNotSay(ORDER_TAKING, 'order-taker filler')],
  },
  {
    name: 'what-do-you-stock',
    why: 'Karim: the list should be titles, no prices and no measurements.',
    caller: ['What do you guys sell?'],
    checks: [
      mustSay(/cushion/i, 'cushion wrap'),
      mustSay(/newsprint/i, 'newsprint'),
      mustSay(/hand wrap|hand film/i, 'hand wrap film'),
      mustSay(/machine/i, 'machine wrap film'),
      mustSay(/carton/i, 'carton sealing tape'),
      mustSay(/hot melt/i, 'hot melt tape'),
      mustNotSay(MEASUREMENT, 'a measurement nobody asked for'),
      mustNotSay(MONEY, 'a price'),
    ],
  },
  {
    name: 'detail-on-request',
    why: 'Karim: it must answer rolls per bundle and dimensions when asked.',
    caller: [
      'How many rolls come in a case of the hot melt tape?',
      'And what size are they?',
      'How many cases fit on a pallet?',
    ],
    checks: [
      mustSay(/36|thirty[- ]six/i, 'the 36 rolls in a case'),
      mustSay(/2 inch|two inch|55|fifty[- ]five/i, 'the 2 inch by 55 yard size'),
      mustSay(/48|forty[- ]eight/, 'the 48 cases per pallet'),
      mustSay(/roughly|about|approximate/i, 'a hedge on the pallet count'),
    ],
  },
  {
    name: 'price-pressure',
    why: 'The no-prices rule under a caller who pushes twice.',
    caller: [
      'Just give me a ballpark on a pallet of hand wrap film.',
      'I understand, I am not going to hold you to it. Roughly what does a pallet cost?',
    ],
    checks: [mustNotSay(MONEY, 'a price'), routesBy(2), mustNotSay(/\bunfortunately\b|I am unable to|I can't\b/i, 'a refusal opener')],
  },
  {
    name: 'bubble-wrap-alias',
    why: 'Cushion Wrap is literally BUBBLE in QuickBooks. Denying it is a lost order.',
    caller: ['Do you carry bubble wrap?'],
    checks: [
      mustSay(/cushion wrap/i, 'Cushion Wrap by name'),
      mustNotSay(/do not carry|don't carry|do not stock|don't stock|do not have|don't have|we do not sell/i, 'that we do not carry it'),
    ],
  },
  {
    name: 'asks-for-a-human',
    why: 'Escalate on the first ask, with no interrogation and no talking them round.',
    caller: ['Can I talk to a real person please?'],
    checks: [
      mustCall('escalate_to_human'),
      mustNotSay(/why|what is it about|what is this regarding|before i (do|transfer)/i, 'an interrogation'),
    ],
  },
  {
    name: 'question-it-cannot-answer',
    why: 'Karim: only answer what it knows 100%, and offer a person otherwise.',
    caller: ['What is your return policy if I open a case and only use half of it?'],
    checks: [
      mustSay(/someone on our team|put you through|pass you|one of (the|our) team/i, 'an offer of a person'),
      mustNotSay(/\b(30|thirty|14|fourteen|60|sixty) days?\b|restocking fee|you can return/i, 'an invented policy'),
    ],
  },
  {
    name: 'we-do-not-sell-that',
    why: 'Say we do not carry it, then name the closest thing we do.',
    caller: ['Do you sell wardrobe boxes?'],
    checks: [
      mustSay(/do not carry|don't carry|do not stock|don't stock|do not sell|don't sell/i, 'that we do not carry boxes'),
      mustNotSay(MONEY, 'a price'),
    ],
  },
];

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

async function complete(turns: Turn[]): Promise<Turn> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      // No max_tokens. Telnyx rejects it alongside function tools with error
      // 10015, "max_completion_tokens (former max_tokens) and function tools can
      // not be used at the same time", which errored all 9 scenarios rather than
      // failing them. The cap was only ever a guard against a runaway answer, and
      // the turn cap in `run()` already bounds the conversation, so dropping it
      // costs nothing. Read the error body before blaming a prompt change: a
      // harness that reports ERROR on every scenario is never the prompt.
      body: JSON.stringify({ model: MODEL, messages: turns, tools: TOOLS }),
    });

    if (res.ok) {
      const json = await res.json();
      const m = json.choices?.[0]?.message;
      if (!m) throw new Error(`no message in response: ${JSON.stringify(json).slice(0, 200)}`);
      return { role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls };
    }

    // 429 and 5xx are worth one retry; anything else is a real problem and
    // failing loudly beats a scorecard built on half a run.
    const body = (await res.text()).slice(0, 300);
    if (attempt >= 3 || (res.status !== 429 && res.status < 500)) {
      throw new Error(`chat completions ${res.status}: ${body}`);
    }
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
}

async function run(s: Scenario): Promise<Transcript> {
  // The greeting is spoken by TTS without passing through the model, so it goes
  // on the wire as an assistant turn that the model did not write. Seeding it is
  // what makes "never ask what they need again" a real check.
  const turns: Turn[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'assistant', content: GREETING },
  ];
  const said: string[] = [];
  const called: string[] = [];

  for (const line of s.caller) {
    turns.push({ role: 'user', content: line });

    // A turn can be text, or tools then text, or several rounds of both. Bounded
    // so a model that loops on a tool cannot spin the harness forever.
    for (let round = 0; round < 4; round++) {
      const reply = await complete(turns);
      turns.push(reply);
      if (reply.content?.trim()) said.push(reply.content.trim());

      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) break;

      for (const c of calls) {
        called.push(c.function.name);
        turns.push({
          role: 'tool',
          tool_call_id: c.id,
          content: TOOL_RESULT[c.function.name] ?? 'Done.',
        });
      }
    }
  }

  return { said, called, turns };
}

const filter = process.argv[2]?.toLowerCase();
const chosen = filter ? SCENARIOS.filter((s) => s.name.toLowerCase().includes(filter)) : SCENARIOS;
if (chosen.length === 0) {
  console.error(`no scenario matches "${filter}". Names: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

console.log(`Rehearsing ${chosen.length} scenario(s) against ${MODEL}\n`);

const results: {
  name: string;
  why: string;
  failures: string[];
  said: string[];
  called: string[];
}[] = [];

for (const s of chosen) {
  let transcript: Transcript;
  try {
    transcript = await run(s);
  } catch (err) {
    results.push({
      name: s.name,
      why: s.why,
      failures: [`harness error: ${err instanceof Error ? err.message : String(err)}`],
      said: [],
      called: [],
    });
    console.log(`ERROR ${s.name}`);
    continue;
  }

  const failures = s.checks.map((c) => c(transcript)).filter((f): f is string => f !== null);
  results.push({ name: s.name, why: s.why, failures, said: transcript.said, called: transcript.called });
  console.log(`${failures.length === 0 ? 'PASS ' : 'FAIL '} ${s.name}`);
  for (const f of failures) console.log(`       - ${f}`);
  // The transcript is the point of a failure, so print it rather than making
  // somebody re-run to see what was actually said.
  if (failures.length > 0) {
    transcript.said.forEach((line, i) => console.log(`       [${i + 1}] ${line.replace(/\n+/g, ' ')}`));
    if (transcript.called.length > 0) console.log(`       tools: ${transcript.called.join(', ')}`);
  }
}

const passed = results.filter((r) => r.failures.length === 0).length;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('out/rehearse', { recursive: true });
const path = `out/rehearse/${stamp}.json`;
writeFileSync(path, `${JSON.stringify({ model: MODEL, passed, total: results.length, results }, null, 2)}\n`);

console.log(`\n${passed}/${results.length} passed. Full transcripts: ${path}`);
process.exit(passed === results.length ? 0 : 1);
