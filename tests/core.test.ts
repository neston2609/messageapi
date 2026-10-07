import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { JsonStore } from '../src/core/store.js';
import { SecretBox } from '../src/core/crypto.js';
import { isOutsideBusinessHours } from '../src/core/router.js';

describe('Step 1 core', () => {
  it('encrypts and authenticates secret values', () => { const box = new SecretBox(randomBytes(32).toString('base64')); const value = box.encrypt('private'); expect(value).not.toContain('private'); expect(box.decrypt(value)).toBe('private'); expect(() => box.decrypt(value.slice(0, -2) + 'xx')).toThrow(); });
  it('writes valid JSON atomically and serializes concurrent writes', async () => { const dir = await mkdtemp(join(tmpdir(), 'bridge-')); const path = join(dir, 'config.json'); const store = new JsonStore(path, z.object({ count: z.number() }), { count: 0 }); await Promise.all([store.write({ count: 1 }), store.write({ count: 2 })]); expect(await store.read()).toEqual({ count: 2 }); expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ count: 2 }); });
});

describe('business hours', () => {
  it('defaults an unset schedule to 24/7', () => { expect(isOutsideBusinessHours({},new Date('2026-09-27T12:00:00Z'))).toBe(false); });
  it('keeps explicit 24/7 open even when legacy hours are present', () => { expect(isOutsideBusinessHours({businessHoursMode:'always',businessHoursStart:'09:00',businessHoursEnd:'17:00',businessHoursTimeZone:'UTC'},new Date('2026-09-27T12:00:00Z'))).toBe(false); });
  it('applies a custom Monday-to-Friday schedule', () => {
    const schedule={businessHoursMode:'scheduled',businessHoursStart:'09:00',businessHoursEnd:'17:00',businessHoursTimeZone:'UTC'};
    expect(isOutsideBusinessHours(schedule,new Date('2026-09-23T12:00:00Z'))).toBe(false);
    expect(isOutsideBusinessHours(schedule,new Date('2026-09-23T18:00:00Z'))).toBe(true);
    expect(isOutsideBusinessHours(schedule,new Date('2026-09-27T12:00:00Z'))).toBe(true);
  });
});
