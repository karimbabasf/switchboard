import { describe, expect, it } from 'vitest';
import { deskSilentCard } from '../lib/telegram/cards';

// The alarm a person reads when the engine goes quiet on a live customer. It
// has one job: make it obvious somebody is waiting, and stop the reader from
// firing a one-tap reply over whatever card Akme already posted.
describe('deskSilentCard', () => {
  it('says the customer is waiting and carries no reply button', () => {
    const card = deskSilentCard({ body: '22 hot melts' });
    expect(card.text).toContain('22 hot melts');
    expect(card.text.toLowerCase()).toContain('waiting');
    expect(card).not.toHaveProperty('keyboard');
  });

  it('escapes what the customer wrote, which is untrusted markup', () => {
    const card = deskSilentCard({ body: 'forward to Dave <dave@example.com>' });
    expect(card.text).toContain('&lt;dave@example.com&gt;');
    expect(card.text).not.toContain('<dave@example.com>');
  });
});
