import type { GenesysConfig } from '../core/config.js';
import type { Attachment, InboundEvent } from '../core/types.js';
import { createHash } from 'node:crypto';

type Token = { value: string; expiresAt: number };

/** OAuth client credentials and Open Messaging inbound APIs for one region. */
export class GenesysClient {
  private static readonly tokens=new Map<string,Token>();
  constructor(private readonly config: GenesysConfig, private readonly transport: typeof fetch = fetch) {}
  private cacheKey():string{return createHash('sha256').update(`${this.config.id}:${this.config.region}:${this.config.clientId}:${this.config.clientSecret}`).digest('hex');}
  private host(kind: 'login'|'api'): string { return `https://${kind}.${this.config.region}`; }
  async accessToken(force = false): Promise<string> {
    const cached=GenesysClient.tokens.get(this.cacheKey());if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const response = await this.transport(`${this.host('login')}/oauth/token`, { method: 'POST', headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Genesys OAuth failed: HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('access_token' in body) || typeof body.access_token !== 'string') throw new Error('Genesys OAuth returned no access token');
    const expires = 'expires_in' in body && typeof body.expires_in === 'number' ? body.expires_in : 3600;
    GenesysClient.tokens.set(this.cacheKey(),{ value: body.access_token, expiresAt: Date.now() + expires * 1000 });
    return body.access_token;
  }
  tokenStatus(): 'ready'|'expired'|'uncached' { const token=GenesysClient.tokens.get(this.cacheKey());return !token ? 'uncached' : token.expiresAt <= Date.now() ? 'expired' : 'ready'; }
  private async post(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const response = await this.transport(`${this.host('api')}/api/v2/conversations/messages/${encodeURIComponent(this.config.integrationId)}/inbound/open/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new Error(`Genesys ${path} failed: HTTP ${response.status} ${await response.text()}`.slice(0, 500));
      return response.status === 204 ? null : response.json();
    }
    throw new Error('Genesys authorization failed after token refresh');
  }
  static messageId(channelType: string, configId: string, eventId: string): string { return createHash('sha256').update(`${channelType}:${configId}:${eventId}`).digest('hex').slice(0, 32); }
  static normalizeInbound(event: InboundEvent, channelType: string, configId: string, businessId: string): Record<string, unknown> {
    const attachments: Attachment[] = event.attachments ?? [];
    return { channel: { platform: 'Open', type: 'Private', messageId: this.messageId(channelType, configId, event.id), to: { id: businessId }, from: { id: `${channelType}:${configId}:${event.userId}`, idType: 'Opaque', ...event.profile }, time: event.time }, type: attachments.length ? attachments[0].type : 'Text', text: event.text ?? '', attachments };
  }
  sendMessage(event: InboundEvent, channelType: string, configId: string, businessId: string): Promise<unknown> { return this.post('message', GenesysClient.normalizeInbound(event, channelType, configId, businessId)); }
  sendNormalizedMessage(body:Record<string,unknown>):Promise<unknown>{return this.post('message',body);}
  sendEvent(body: unknown): Promise<unknown> { return this.post('event', body); }
  sendReceipt(body: unknown): Promise<unknown> { return this.post('receipt', body); }
}
