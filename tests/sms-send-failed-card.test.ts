import { afterEach, describe, expect, it, vi } from 'vitest';
import { smsSendFailedCard } from '../lib/telegram/cards';

/**
 * The alarm a person reads when the carrier, and not this repo, is the reason
 * a customer heard nothing.
 *
 * It was the last silent outcome on the reply path: a Telnyx 500 rethrew into
 * replyWithAgent's outer catch, which is a bare console.error, so the customer
 * got nothing, the timeline got no outbound row, Telegram showed only the
 * inbound card, and Akme had already recorded the quote as sent.
 *
 * The card carries a third party's error text, and Telegram is a group chat,
 * so the redaction below is part of the card and not a caller's manners.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('smsSendFailedCard', () => {
  it('says who missed it, what they would have read, and why it failed', () => {
    const card = smsSendFailedCard({
      phone: '+14155550111',
      reply: 'Hi, tan hot melt tape is $24.42 a case. How many do you need?',
      reason: 'telnyx /messages: 500 internal error',
    });
    expect(card.text).toContain('415');
    expect(card.text).toContain('$24.42 a case');
    expect(card.text).toContain('500 internal error');
  });

  it('tells the reader to check Akme before answering, because a quote may be recorded as sent', () => {
    const card = smsSendFailedCard({ phone: '+14155550111', reply: 'Hi.', reason: 'ECONNRESET' });
    expect(card.text).toContain('Akme');
    expect(card).not.toHaveProperty('reply_markup');
  });

  it('escapes the reply and the reason, which are untrusted markup', () => {
    const card = smsSendFailedCard({
      phone: '+14155550111',
      reply: 'ask for Dave <dave@example.com>',
      reason: '<b>502</b>',
    });
    expect(card.text).toContain('&lt;dave@example.com&gt;');
    expect(card.text).not.toContain('<dave@example.com>');
    expect(card.text).toContain('&lt;b&gt;502&lt;/b&gt;');
  });

  it('never carries a credential, whatever the error text had in it', () => {
    vi.stubEnv('TELNYX_API_KEY', 'KEY01998superSecretValue');
    vi.stubEnv('DESK_INBOUND_SECRET', 'desk-inbound-secret-value');
    const card = smsSendFailedCard({
      phone: '+14155550111',
      reply: 'Hi.',
      reason: 'auth failed for KEY01998superSecretValue and desk-inbound-secret-value',
    });
    expect(card.text).not.toContain('KEY01998superSecretValue');
    expect(card.text).not.toContain('desk-inbound-secret-value');
    expect(card.text).toContain('[redacted]');
  });

  it('strips a bearer token that came from somewhere other than the environment', () => {
    const card = smsSendFailedCard({
      phone: '+14155550111',
      reply: 'Hi.',
      reason: 'rejected header authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc',
    });
    expect(card.text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(card.text).toContain('Bearer [redacted]');
  });

  // Telegram caps a message at 4096 characters, and a gateway that answers with
  // an HTML error page will happily spend all of it. The words the customer
  // missed are the point of the card, so the reason is what gets clipped.
  it('clips a runaway error body so the reply it is about survives', () => {
    const card = smsSendFailedCard({
      phone: '+14155550111',
      reply: 'Hi, that is $24.42 a case.',
      reason: 'x'.repeat(5000),
    });
    expect(card.text.length).toBeLessThan(1000);
    expect(card.text).toContain('$24.42 a case');
  });
});
