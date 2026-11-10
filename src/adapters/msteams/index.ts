import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { ChannelConfig } from '../../core/config.js';
import type { ChannelAdapter, InboundEvent, OutboundEvent, RawRequest, SendResult } from '../../core/types.js';

const signingKeysUrl = 'https://login.botframework.com/v1/.well-known/keys';
const tokenUrl = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const tokenIssuer = 'https://api.botframework.com';

type SigningKey = JsonWebKey & { kid?: string; use?: string; alg?: string; endorsements?: string[] };
type BotActivity = {
  type?: string;
  id?: string;
  timestamp?: string;
  channelId?: string;
  serviceUrl?: string;
  from?: { id?: string; name?: string };
  conversation?: { id?: string; tenantId?: string };
  text?: string;
};
type ConversationContext = { conversationId: string; serviceUrl: string };

function decodeSegment(value: string): Record<string, unknown> | null {
  try {
    const result: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : null;
  } catch { return null; }
}

function conversationContext(value: string | undefined): ConversationContext | null {
  if (!value?.startsWith('teams:')) return null;
  const parsed = decodeSegment(value.slice(6));
  if (typeof parsed?.conversationId !== 'string' || typeof parsed.serviceUrl !== 'string') return null;
  return { conversationId: parsed.conversationId, serviceUrl: parsed.serviceUrl };
}

function trustedServiceUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const allowedHosts = new Set([
      'smba.trafficmanager.net',
      'smba.infra.gcc.teams.microsoft.com',
      'smba.infra.gov.teams.microsoft.us',
      'smba.infra.dod.teams.microsoft.us',
    ]);
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase()) || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash || !/^\/(?:[A-Za-z0-9_-]+\/)?$/.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

/** Microsoft Teams Bot Framework adapter using channel JWT validation and Connector OAuth. */
export class MicrosoftTeamsAdapter implements ChannelAdapter {
  readonly type = 'msteams' as const;
  readonly capabilities = { text:true, image:false, video:false, audio:false, file:false, quickReply:false, card:false, carousel:false, typing:false, readReceipt:false, maxTextLength:28_000, sessionWindowHours:null };
  private signingKeys?: { expiresAt: number; keys: SigningKey[] };
  private keyRefreshNotBefore = 0;
  private readonly accessTokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly transport: typeof fetch = fetch) {}

  private async keys(forceRefresh = false): Promise<SigningKey[]> {
    if (!forceRefresh && this.signingKeys && this.signingKeys.expiresAt > Date.now()) return this.signingKeys.keys;
    const response = await this.transport(signingKeysUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Bot Framework signing keys failed: HTTP ${response.status}`);
    const body = await response.json() as { keys?: SigningKey[] };
    if (!Array.isArray(body.keys)) throw new Error('Bot Framework signing keys response is invalid');
    const cacheControl = response.headers.get('cache-control') ?? '';
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl)?.[1];
    const ttl = Math.min(3_600, Math.max(60, maxAge ? Number(maxAge) : 3_600)) * 1000;
    this.signingKeys = { keys: body.keys, expiresAt: Date.now() + ttl };
    return body.keys;
  }

  async verifyWebhook(req: RawRequest, cfg: ChannelConfig): Promise<boolean> {
    const authorization = req.headers.authorization;
    const appId = cfg.credentials.MicrosoftAppId;
    if (typeof authorization !== 'string' || !appId || authorization.length > 16_384) return false;
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
    if (!match) return false;
    const token = match[1]!;
    const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');
    const header = decodeSegment(encodedHeader!);
    const claims = decodeSegment(encodedClaims!);
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !claims) return false;
    if (claims.iss !== tokenIssuer || claims.aud !== appId) return false;
    const activity = req.body as BotActivity;
    if (typeof activity?.serviceUrl !== 'string' || claims.serviceUrl !== activity.serviceUrl || activity.channelId !== 'msteams') return false;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || typeof claims.nbf !== 'number' || claims.exp < now - 300 || claims.nbf > now + 300 || claims.nbf > claims.exp) return false;

    try {
      let keys = await this.keys();
      let key = keys.find(item => item.kid === header.kid && item.kty === 'RSA' && (!item.use || item.use === 'sig') && item.endorsements?.includes('msteams'));
      if (!key && Date.now() >= this.keyRefreshNotBefore) {
        this.keyRefreshNotBefore = Date.now() + 60_000;
        keys = await this.keys(true);
        key = keys.find(item => item.kid === header.kid && item.kty === 'RSA' && (!item.use || item.use === 'sig') && item.endorsements?.includes('msteams'));
      }
      if (!key) return false;
      const publicKey = createPublicKey({ key:key as import('node:crypto').JsonWebKey, format: 'jwk' });
      return verifySignature('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), publicKey, Buffer.from(encodedSignature!, 'base64url'));
    } catch { return false; }
  }

  async parseInbound(req: RawRequest): Promise<InboundEvent[]> {
    const activity = req.body as BotActivity;
    if (activity?.type !== 'message') return [];
    const conversationId = activity.conversation?.id;
    const senderId = activity.from?.id;
    const serviceUrl = activity.serviceUrl;
    if (!activity.id || !conversationId || !senderId || !serviceUrl || !trustedServiceUrl(serviceUrl)) throw new Error('Teams message is missing a valid activity, sender, conversation, or service URL');
    const userId = activity.conversation?.tenantId ? `${activity.conversation.tenantId}:${conversationId}:${senderId}` : `${conversationId}:${senderId}`;
    const context = Buffer.from(JSON.stringify({ conversationId, serviceUrl }), 'utf8').toString('base64url');
    const parsedTime = activity.timestamp ? new Date(activity.timestamp) : new Date();
    return [{
      id: activity.id,
      userId,
      time: Number.isNaN(parsedTime.getTime()) ? new Date().toISOString() : parsedTime.toISOString(),
      text: activity.text,
      conversationId: `teams:${context}`,
      profile: activity.from?.name ? { nickname: activity.from.name } : undefined,
    }];
  }

  private async connectorToken(cfg: ChannelConfig): Promise<string> {
    const clientId = cfg.credentials.MicrosoftAppId;
    const clientSecret = cfg.credentials.MicrosoftAppPassword;
    if (!clientId || !clientSecret) throw new Error('Microsoft Teams app ID and app password are required');
    const tenantId = cfg.credentials.MicrosoftAppTenantId;
    if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error('MicrosoftAppTenantId must be a tenant UUID');
    const cacheKey = createHash('sha256').update(`${clientId}:${tenantId ?? 'botframework'}:${clientSecret}`).digest('hex');
    const cached = this.accessTokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const endpoint = tenantId ? `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token` : tokenUrl;
    const body = new URLSearchParams({ grant_type:'client_credentials', client_id:clientId, client_secret:clientSecret, scope:'https://api.botframework.com/.default' });
    const response = await this.transport(endpoint, { method:'POST', headers:{ 'content-type':'application/x-www-form-urlencoded' }, body, signal:AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Microsoft Bot Framework OAuth failed: HTTP ${response.status}`);
    const result = await response.json() as { access_token?: string; expires_in?: number };
    if (!result.access_token) throw new Error('Microsoft Bot Framework OAuth returned no access token');
    this.accessTokens.set(cacheKey, { value:result.access_token, expiresAt:Date.now() + (typeof result.expires_in === 'number' ? result.expires_in : 3600) * 1000 });
    return result.access_token;
  }

  async sendOutbound(msg: OutboundEvent, cfg: ChannelConfig): Promise<SendResult> {
    const context = conversationContext(msg.replyToId);
    if (!context) throw new Error('Teams conversation context is missing; the user must message the bot first');
    const serviceUrl = trustedServiceUrl(context.serviceUrl);
    if (!serviceUrl) throw new Error('Teams service URL is not an approved Bot Framework endpoint');
    const text = [msg.text, ...(msg.quickReplies ?? []).map((item, index) => `${index + 1}. ${item}`), ...(msg.cards ?? []).map(card => [card.title, card.description, card.url].filter(Boolean).join('\n')), ...(msg.attachments ?? []).map(item => item.url)].filter(Boolean).join('\n');
    if (!text) return { delivered:true };
    const basePath = serviceUrl.pathname.replace(/\/+$/, '');
    const endpoint = new URL(`${basePath}/v3/conversations/${encodeURIComponent(context.conversationId)}/activities`, serviceUrl.origin);
    const response = await this.transport(endpoint, {
      method:'POST',
      headers:{ authorization:`Bearer ${await this.connectorToken(cfg)}`, 'content-type':'application/json' },
      body:JSON.stringify({ type:'message', text }),
      signal:AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Microsoft Teams send failed: HTTP ${response.status} ${await response.text()}`.slice(0, 500));
    const result = await response.json().catch(() => ({})) as { id?: string };
    return { id:result.id, delivered:true };
  }

  async healthCheck(cfg: ChannelConfig) {
    const ok = Boolean(cfg.credentials.MicrosoftAppId && cfg.credentials.MicrosoftAppPassword);
    return { ok, detail:ok ? 'Microsoft Teams Bot Framework credentials configured' : 'MicrosoftAppId and MicrosoftAppPassword are required' };
  }
}
