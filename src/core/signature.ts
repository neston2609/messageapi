import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyHmac(raw: Buffer, secret: string, supplied: string | undefined, encoding: 'hex'|'base64', prefix = ''): boolean {
  if (!secret || !supplied?.startsWith(prefix)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  let actual: Buffer;
  try { actual = Buffer.from(supplied.slice(prefix.length), encoding); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
