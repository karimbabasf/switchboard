/**
 * Dry run: proves the whole post-call pipeline WITHOUT a phone.
 *
 *   pnpm dev                 # in another terminal
 *   pnpm dry-run             # transcribe -> summarize -> Telegram card
 *   pnpm dry-run --cleanup   # remove the rows, the topic and the audio afterwards
 *
 * Telnyx is the only thing this cannot exercise. Everything after the recording
 * exists is real: Supabase Storage, AssemblyAI multichannel, NEAR AI summary,
 * the outbox drain and the Telegram card, driven through the real worker route
 * rather than by importing the steps, so the HTTP path is covered too.
 *
 * The synthetic recording is genuinely dual-channel, one speaker per physical
 * channel, because that is the assumption the whole transcript design rests on
 * and it is a recording-time decision that cannot be checked after a real call.
 *
 * The caller is a number that does NOT exist yet, on purpose: a first-time
 * caller's card has to open its own Telegram topic, and landing in General
 * instead is a bug that has shipped twice.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CALLER = '+12125550188';
const CALLER_NAME = 'Maria Delgado (dry run)';
const WORKER_URL = process.env.DRY_RUN_WORKER_URL ?? 'http://localhost:3000/api/worker';

/** Two turns is enough to prove the channels separate; more would just cost transcription time. */
const SCRIPT: { voice: string; line: string }[] = [
  {
    voice: 'Samantha',
    line: "Hi, this is Maria Delgado. I'm calling about invoice ten forty three for the moving boxes we ordered last week. I wanted to check whether our payment went through, and whether the twenty wardrobe boxes are still on the truck for Thursday.",
  },
  {
    voice: 'Daniel',
    line: 'Hi Maria, thanks for calling Akme. Let me pull that up. Invoice ten forty three is showing as paid on Tuesday, and the twenty wardrobe boxes are scheduled for Thursday morning, between nine and eleven. I will text you a confirmation before the driver leaves.',
  },
];

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`\n  ${name} is empty in .env.local. Run pnpm preflight for the full list.\n`);
    process.exit(1);
  }
  return value;
}

function rest(path: string): string {
  return `${env('SUPABASE_URL').replace(/\/$/, '')}/rest/v1/${path}`;
}

function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra };
}

async function seconds(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  return Number.parseFloat(stdout.trim());
}

/**
 * Builds a 2-channel MP3 where channel 1 only ever carries the caller and
 * channel 2 only ever carries the Akme side, with each padded to the full
 * length so neither is truncated by amerge.
 */
async function buildRecording(dir: string): Promise<string> {
  const mono: string[] = [];
  for (const [i, turn] of SCRIPT.entries()) {
    const aiff = join(dir, `turn-${i}.aiff`);
    await run('say', ['-v', turn.voice, '-o', aiff, turn.line]);
    mono.push(aiff);
  }

  const [callerLen, agentLen] = await Promise.all(mono.map(seconds));
  const total = callerLen + agentLen + 0.5;
  const delayMs = Math.round(callerLen * 1000);
  const out = join(dir, 'call.mp3');

  await run('ffmpeg', [
    '-y',
    '-i', mono[0],
    '-i', mono[1],
    '-filter_complex',
    `[0:a]aformat=sample_rates=16000:channel_layouts=mono,apad=whole_dur=${total}[a];` +
      `[1:a]aformat=sample_rates=16000:channel_layouts=mono,adelay=${delayMs},apad=whole_dur=${total}[b];` +
      `[a][b]amerge=inputs=2[out]`,
    '-map', '[out]',
    '-ac', '2',
    '-ar', '16000',
    // MP3, matching the `format: 'mp3'` we ask Telnyx for in lib/telnyx/voice.ts.
    // Telegram's sendAudio rejects WAV by URL, so a WAV here would fail in a way
    // production never can, which makes the rehearsal lie in both directions.
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    // Joint stereo lets the encoder share information between L and R. The whole
    // point of a dual-channel recording is that it does not, so force it off.
    '-joint_stereo', '0',
    out,
  ]);

  return out;
}

async function upload(localPath: string, storagePath: string): Promise<void> {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'recordings';
  const url = `${env('SUPABASE_URL').replace(/\/$/, '')}/storage/v1/object/${bucket}/${storagePath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
      'content-type': 'audio/mpeg',
      'x-upsert': 'true',
    },
    body: await readFile(localPath),
  });
  if (!res.ok) throw new Error(`storage upload failed: HTTP ${res.status} ${await res.text()}`);
}

async function seedRows(storagePath: string): Promise<string> {
  const contact = await fetch(rest('contacts'), {
    method: 'POST',
    headers: restHeaders({ prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify({ phone: CALLER, display_name: CALLER_NAME }),
  });
  if (!contact.ok) throw new Error(`contact insert failed: HTTP ${contact.status} ${await contact.text()}`);

  // status 'fetching' means "the recording has been fetched", so the next step
  // is transcription. That is the one step Telnyx would have done for us.
  const call = await fetch(rest('calls'), {
    method: 'POST',
    headers: restHeaders({ prefer: 'return=representation' }),
    body: JSON.stringify({
      contact_phone: CALLER,
      direction: 'inbound',
      was_answered: true,
      status: 'fetching',
      storage_path: storagePath,
      duration_sec: 30,
    }),
  });
  if (!call.ok) throw new Error(`call insert failed: HTTP ${call.status} ${await call.text()}`);

  const [row] = (await call.json()) as { id: string }[];
  return row.id;
}

async function tickWorker(): Promise<Record<string, number>> {
  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env('WORKER_SECRET')}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`worker returned HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, number>;
}

async function readCall(id: string) {
  const res = await fetch(
    rest(`calls?id=eq.${id}&select=status,transcript,summary,last_error,attempts`),
    { headers: restHeaders() },
  );
  const [row] = (await res.json()) as {
    status: string;
    transcript: string | null;
    summary: Record<string, unknown> | null;
    last_error: string | null;
    attempts: number;
  }[];
  return row;
}

async function cleanup(storagePath: string): Promise<void> {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'recordings';
  const base = env('SUPABASE_URL').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');

  await fetch(rest(`calls?contact_phone=eq.${encodeURIComponent(CALLER)}`), {
    method: 'DELETE',
    headers: restHeaders(),
  });
  await fetch(rest(`contacts?phone=eq.${encodeURIComponent(CALLER)}`), {
    method: 'DELETE',
    headers: restHeaders(),
  });
  await fetch(`${base}/storage/v1/object/${bucket}/${storagePath}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${key}` },
  });
  console.log(`\n  cleaned up: call rows, contact ${CALLER}, and ${storagePath}`);
  console.log('  the Telegram topic stays; delete it by hand if you want it gone.\n');
}

const STORAGE_PATH = 'dry-run/pipeline-check.mp3';

async function main() {
  const cleanupOnly = process.argv.includes('--cleanup');
  if (cleanupOnly) {
    await cleanup(STORAGE_PATH);
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'switchboard-dry-run-'));
  try {
    console.log('\n  building a dual-channel recording with say + ffmpeg...');
    const wav = await buildRecording(dir);
    console.log(`  ${(await seconds(wav)).toFixed(1)}s, 2 channels, one speaker each`);

    console.log('  uploading to Supabase Storage...');
    await upload(wav, STORAGE_PATH);

    console.log('  seeding a first-time caller and a call row...');
    const id = await seedRows(STORAGE_PATH);
    console.log(`  call ${id}`);

    // transcribe, then summarize, then post: one step per tick, same as pg_cron.
    for (const step of ['transcribing', 'summarizing', 'posting the card']) {
      console.log(`\n  worker tick (${step})...`);
      const result = await tickWorker();
      console.log(`  ${JSON.stringify(result)}`);
      const row = await readCall(id);
      if (row.last_error) console.log(`  last_error: ${row.last_error} (attempt ${row.attempts})`);
      if (row.status === 'failed') throw new Error(`call failed: ${row.last_error}`);
    }

    const final = await readCall(id);
    console.log(`\n  status: ${final.status}`);
    console.log('\n  --- transcript ---');
    console.log(final.transcript ?? '(none)');
    console.log('\n  --- summary ---');
    console.log(JSON.stringify(final.summary, null, 2));
    console.log(
      final.status === 'posted'
        ? `\n  Check Telegram: a topic for ${CALLER} should exist with the card in it.\n  Then: pnpm dry-run --cleanup\n`
        : `\n  Did not reach 'posted'. Check last_error above.\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
