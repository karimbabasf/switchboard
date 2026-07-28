import { runTool, toolDeps } from '@/lib/agent/tools';
import { TOOL_NAMES, type ToolName } from '@/lib/telnyx/assistant';
import {
  TELNYX_SIGNATURE_HEADER,
  TELNYX_TIMESTAMP_HEADER,
  verifyTelnyxWebhook,
} from '@/lib/telnyx/signature';
import { env } from '@/lib/env';

/**
 * The agent's tools, one route for all four.
 *
 * Two doors, both required. The Ed25519 signature proves Telnyx sent it, over
 * the same `${timestamp}|${rawBody}` scheme as every other Telnyx webhook. The
 * shared secret proves it came from OUR assistant rather than any assistant on
 * anyone's Telnyx account, since the signing key is per-organisation and the
 * URL is guessable.
 *
 * Unlike the Call Control webhook there is nothing to defer: the response body
 * is the tool's answer, and the agent is holding a caller on the line waiting
 * for it.
 */

export const runtime = 'nodejs';
export const maxDuration = 15;

function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/** Length-independent compare, so a wrong secret cannot be found byte by byte. */
function secretMatches(given: string | null): boolean {
  const expected = env('AGENT_TOOL_SECRET');
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tool: string }> },
): Promise<Response> {
  const { tool } = await params;

  // Raw bytes, never request.json(): the signature covers exactly what was sent.
  const rawBody = await request.text();

  const verdict = verifyTelnyxWebhook(
    rawBody,
    request.headers.get(TELNYX_SIGNATURE_HEADER),
    request.headers.get(TELNYX_TIMESTAMP_HEADER),
  );
  if (!verdict.ok) return new Response(verdict.reason ?? 'bad signature', { status: 403 });

  if (!secretMatches(request.headers.get('x-agent-secret'))) {
    return new Response('bad agent secret', { status: 403 });
  }

  if (!isToolName(tool)) return new Response(`unknown tool: ${tool}`, { status: 404 });

  let args: Record<string, unknown>;
  try {
    args = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  try {
    const result = await runTool(tool, args, toolDeps());
    return Response.json(result);
  } catch (err) {
    console.error(`[agent] tool ${tool} failed:`, err);
    // The agent is mid-sentence with a caller. A 500 leaves it with nothing to
    // say, so it gets a sentence that is true and keeps the call moving.
    return Response.json({
      speech: 'I am having trouble looking that up. Let me take a message and have someone call you back.',
    });
  }
}
