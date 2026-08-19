import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { OPENER } from '../lib/agent/brief';
import { agentVoice, voiceSpeed } from '../lib/telnyx/assistant';
import {
  OPENER_BUILD,
  openerFilePath,
  openerFingerprint,
  openerText,
} from '../lib/telnyx/opener';

/**
 * The disclosure is pre-rendered, and the whole risk of pre-rendering it is that
 * the recording and the script can drift apart without anything looking wrong.
 * A caller would hear a legal notice that no longer matches what we do, and no
 * test, log line or type error would fire. These are that alarm.
 *
 * Every failure here has the same fix: `pnpm opener:render`, then commit both
 * the mp3 and the generated opener-build.ts.
 */
describe('pre-rendered opener', () => {
  it('was rendered from the opener the code says today', () => {
    expect(OPENER_BUILD.text).toBe(openerText());
  });

  it('was rendered in the voice the assistant speaks with', () => {
    // The disclosure and the agent are one person on the call. If these differ,
    // the caller hears the notice read by somebody other than whoever says
    // hello, which is what Karim heard on 2026-08-19.
    expect(OPENER_BUILD.voice).toBe(agentVoice());
    expect(OPENER_BUILD.speed).toBe(voiceSpeed());
  });

  it('names the same fingerprint the current config hashes to', () => {
    expect(OPENER_BUILD.fingerprint).toBe(openerFingerprint());
  });

  it('has an audio file committed under that fingerprint', () => {
    expect(existsSync(openerFilePath())).toBe(true);
  });

  it('still carries the recording notice, whatever else the wording does', () => {
    // The one sentence that is not editorial. California is an all-party consent
    // state and the recording starts when this finishes playing.
    expect(openerText().toLowerCase()).toContain('recorded');
    expect(OPENER_BUILD.text.toLowerCase()).toContain('recorded');
  });

  it('falls back to the brief when no override is configured', () => {
    expect(openerText()).toBe(process.env.RECORDING_DISCLOSURE?.trim() || OPENER);
  });
});
