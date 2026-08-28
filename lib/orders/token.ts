import { randomBytes } from 'node:crypto';

/**
 * The one token generator, shared by the quote store and the draft store.
 *
 * It lives in its own file rather than in either of them because neither owns
 * it: a draft is created from a claimed quote, but a draft token is not a quote
 * token and importing one store into the other to borrow a random number would
 * say otherwise.
 *
 * 32 bytes, base64url. Unguessable, url safe, and short enough to sit in a link
 * a customer opens on a phone. The draft token is the ONLY thing between a
 * stranger and somebody's order details, so this is a security parameter and not
 * a formatting choice.
 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
