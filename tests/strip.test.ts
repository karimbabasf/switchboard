import { describe, expect, it } from 'vitest';
import { Stripper, stripMarkup } from '../lib/agent/strip.ts';

/**
 * The samples below are copied from real rehearsal transcripts on 2026-08-15,
 * not invented. `out/rehearse/2026-08-15T06-40-19-826Z.json` is where the
 * `</mm:think>` turns came from.
 */

describe('stripMarkup', () => {
  it('drops the orphan closer MiniMax puts in front of a post-tool turn', () => {
    expect(stripMarkup('</mm:think>It is on the way. Anything else?')).toBe(
      'It is on the way. Anything else?',
    );
    expect(stripMarkup('</mm:think>We have it.')).toBe('We have it.');
    expect(
      stripMarkup('</mm:think>Got it, the list is on its way to you and the request is with us.'),
    ).toBe('Got it, the list is on its way to you and the request is with us.');
  });

  it('drops a whole thinking block, contents included', () => {
    expect(stripMarkup('<think>The caller wants tape. Route them.</think>Definitely, we carry that.')).toBe(
      'Definitely, we carry that.',
    );
  });

  it('leaves an ordinary answer completely alone', () => {
    const clean =
      'Will call is at twelve thirty-four Example Way, in Springfield, Monday to Friday, eight to four.';
    expect(stripMarkup(clean)).toBe(clean);
  });

  it('does not eat a caller sentence that merely contains a less-than sign', () => {
    expect(stripMarkup('Anything under 5 < 10 cases ships the same week.')).toBe(
      'Anything under 5 < 10 cases ships the same week.',
    );
  });

  it('drops tags from any model, not just the one that caused this', () => {
    expect(stripMarkup('<reasoning>x</reasoning>Yes.')).toBe('Yes.');
    expect(stripMarkup('<thinking>y</thinking>Yes.')).toBe('Yes.');
    expect(stripMarkup('</think>Yes.')).toBe('Yes.');
  });
});

describe('Stripper, streaming', () => {
  /** Feed one character at a time: the worst case a token stream can produce. */
  function byChar(input: string): string {
    const s = new Stripper();
    let out = '';
    for (const ch of input) out += s.push(ch);
    return out + s.flush();
  }

  /** Feed split at exactly one boundary, for every boundary. */
  function everySplit(input: string): string[] {
    const seen: string[] = [];
    for (let i = 0; i <= input.length; i++) {
      const s = new Stripper();
      seen.push(s.push(input.slice(0, i)) + s.push(input.slice(i)) + s.flush());
    }
    return seen;
  }

  it('survives a tag split across chunks, at every split point', () => {
    const input = '</mm:think>It is on the way.';
    for (const got of everySplit(input)) expect(got).toBe('It is on the way.');
  });

  it('survives a whole block split across chunks, at every split point', () => {
    const input = '<mm:think>private reasoning here</mm:think>We have it.';
    for (const got of everySplit(input)) expect(got).toBe('We have it.');
  });

  it('survives arriving one character at a time', () => {
    expect(byChar('</mm:think>It is on the way.')).toBe('It is on the way.');
    expect(byChar('<think>hidden</think>Spoken.')).toBe('Spoken.');
    expect(byChar('Nothing to strip at all.')).toBe('Nothing to strip at all.');
  });

  it('never emits a fragment of a tag', () => {
    // The bug a stateless per-chunk regex has: `</mm:` goes out, then `think>`.
    const s = new Stripper();
    const first = s.push('</mm:');
    expect(first).toBe('');
    expect(s.push('think>On its way.')).toBe('On its way.');
  });

  it('holds back an unterminated tag rather than speaking it', () => {
    const s = new Stripper();
    expect(s.push('Sure thing.<mm:think')).toBe('Sure thing.');
    expect(s.flush()).toBe('');
  });

  it('releases a stray bracket that never became a tag', () => {
    const s = new Stripper();
    expect(s.push('cases < ')).toBe('cases < ');
    expect(s.flush()).toBe('');
  });
});
