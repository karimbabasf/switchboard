/**
 * Summarize step: turns a call transcript into the CallSummary shape the
 * Telegram card needs. The model is forced to answer through a single tool
 * call rather than free text, and the tool input is validated again on our
 * side, so a malformed response fails loudly and gets retried instead of a
 * half-formed summary getting stored.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env';
import type { Call, CallSummary } from '../types';

const MODEL = 'claude-haiku-4-5-20251001';
const TOOL_NAME = 'record_call_summary';

const SUMMARY_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: 'Record a structured summary of a phone call transcript.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One line: what the call was about.' },
      caller_wanted: { type: 'string', description: 'What the caller was after.' },
      commitments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Anything we said we would do.',
      },
      action_items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Follow-up work this call created.',
      },
      needs_followup: { type: 'boolean', description: 'Whether a human needs to follow up.' },
      sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    },
    required: ['headline', 'caller_wanted', 'commitments', 'action_items', 'needs_followup', 'sentiment'],
    additionalProperties: false,
  },
  strict: true,
};

export class MalformedSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedSummaryError';
  }
}

export async function summarizeCall(call: Call): Promise<CallSummary> {
  if (!call.transcript) {
    throw new Error(`call ${call.id} has no transcript; transcription has not run yet`);
  }

  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      'You summarize phone call transcripts for a small moving-supplies business. Be concrete and brief; never invent details the transcript does not support.',
    tools: [SUMMARY_TOOL],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: `Direction: ${call.direction}\n\nTranscript:\n${call.transcript}`,
      },
    ],
  });

  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME,
  );
  if (!block) {
    throw new MalformedSummaryError('model did not return the record_call_summary tool call');
  }

  return validateCallSummary(block.input);
}

const SENTIMENTS = new Set(['positive', 'neutral', 'negative']);

/** strict:true keeps the model honest about shape; this keeps a client or API bug from sneaking a bad value into storage. */
export function validateCallSummary(input: unknown): CallSummary {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedSummaryError('tool input is not an object');
  }
  const v = input as Record<string, unknown>;

  if (typeof v.headline !== 'string' || v.headline.length === 0) {
    throw new MalformedSummaryError('headline is missing or not a non-empty string');
  }
  if (typeof v.caller_wanted !== 'string') {
    throw new MalformedSummaryError('caller_wanted is missing or not a string');
  }
  if (!Array.isArray(v.commitments) || !v.commitments.every((x) => typeof x === 'string')) {
    throw new MalformedSummaryError('commitments is missing or not an array of strings');
  }
  if (!Array.isArray(v.action_items) || !v.action_items.every((x) => typeof x === 'string')) {
    throw new MalformedSummaryError('action_items is missing or not an array of strings');
  }
  if (typeof v.needs_followup !== 'boolean') {
    throw new MalformedSummaryError('needs_followup is missing or not a boolean');
  }
  if (typeof v.sentiment !== 'string' || !SENTIMENTS.has(v.sentiment)) {
    throw new MalformedSummaryError('sentiment is missing or not one of positive/neutral/negative');
  }

  return {
    headline: v.headline,
    caller_wanted: v.caller_wanted,
    commitments: v.commitments as string[],
    action_items: v.action_items as string[],
    needs_followup: v.needs_followup,
    sentiment: v.sentiment as CallSummary['sentiment'],
  };
}
