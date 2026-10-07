import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM envelope for configuration secret fields. */
export class SecretBox {
  private readonly key: Buffer;
  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64');
    if (this.key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
  }
  decrypt(envelope: string): string {
    const [prefix, version, iv, tag, body] = envelope.split(':');
    if (prefix !== 'enc' || version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Invalid encrypted secret envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  }
}
