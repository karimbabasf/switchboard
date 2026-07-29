import { describe, expect, it } from 'vitest';
import { audioContentType } from '../lib/worker/recording';

describe('audioContentType: what we tell Storage the recording is', () => {
  it('rejects the generic type Telnyx actually sends', () => {
    // This is the real header from a real Telnyx recording download, and the
    // exact string Supabase Storage refuses with "mime type binary/
    // octet-stream is not supported". Every live call failed on it.
    expect(audioContentType('binary/octet-stream')).toBe('audio/mpeg');
  });

  it('falls back when the header is missing entirely', () => {
    expect(audioContentType(null)).toBe('audio/mpeg');
  });

  it('falls back on any non-audio type, not just the one we have seen', () => {
    for (const header of ['application/octet-stream', 'text/html', '', '   ']) {
      expect(audioContentType(header)).toBe('audio/mpeg');
    }
  });

  it('keeps a genuine audio type, so a wav recording is still labelled wav', () => {
    expect(audioContentType('audio/wav')).toBe('audio/wav');
    expect(audioContentType('audio/mpeg')).toBe('audio/mpeg');
  });

  it('is case-insensitive and tolerates whitespace, as headers are', () => {
    expect(audioContentType('  Audio/WAV  ')).toBe('Audio/WAV');
  });
});
