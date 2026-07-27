/**
 * Typed environment access. Every consumer goes through here so a missing
 * credential fails loudly at the call site instead of becoming `undefined`
 * three layers down.
 */

export function env(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

export function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** E.164 is the only phone format allowed to cross a module boundary here. */
export const E164 = /^\+[1-9]\d{7,14}$/;

export function assertE164(phone: string, label = 'phone'): string {
  if (!E164.test(phone)) throw new Error(`${label} is not E.164: ${phone}`);
  return phone;
}

/**
 * Telnyx sends numbers in E.164 already, but Takeout imports and human input do
 * not. Normalizes US 10 and 11 digit forms; anything else must already be E.164.
 */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (E164.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
