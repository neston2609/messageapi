import type { ChannelConfig } from '../../core/config.js';
import type { ChannelAdapter, InboundEvent, OutboundEvent, RawRequest, SendResult } from '../../core/types.js';
import { verifyHmac } from '../../core/signature.js';

type LineEvent = { type?: string; timestamp?: number; replyToken?: string; source?: { userId?: string }; message?: { id?: string; type?: string; text?: string } };
type LineWebhook = { events?: LineEvent[] };

export class LineAdapter implements ChannelAdapter {
  readonly type = 'line' as const;
  readonly capabilities = { text: true, image: true, video: true, audio: true, file: false, quickReply: true, card: false, carousel: false, typing: false, readReceipt: false, maxTextLength: 5000, sessionWindowHours: null };
  async verifyWebhook(req: RawRequest, cfg: ChannelConfig): Promise<boolean> { const header = req.headers['x-line-signature']; return verifyHmac(req.rawBody, cfg.credentials.channelSecret ?? '', typeof header === 'string' ? header : undefined, 'base64'); }
  async parseInbound(req: RawRequest): Promise<InboundEvent[]> {
    const body = req.body as LineWebhook;
    return (body.events ?? []).filter(e => e.source?.userId && e.message?.id).map(e => ({ id: e.message!.id!, userId: e.source!.userId!, time: new Date(e.timestamp ?? Date.now()).toISOString(), text: e.message?.text,replyToken:e.replyToken, attachments: e.message?.type && e.message.type !== 'text' ? [{ type: e.message.type === 'image' ? 'Image' as const : e.message.type === 'video' ? 'Video' as const : e.message.type === 'audio' ? 'Audio' as const : 'File' as const, url: `line-content:${e.message.id}` }] : undefined }));
  }
  async sendOutbound(msg: OutboundEvent, cfg: ChannelConfig): Promise<SendResult> {
    const token = cfg.credentials.channelAccessToken;
    if (!token) throw new Error('LINE channelAccessToken is missing');
    const text = [msg.text, ...(msg.cards ?? []).map(c => `${c.title}${c.description ? `\n${c.description}` : ''}${c.url ? `\n${c.url}` : ''}`)].filter(Boolean).join('\n');
    const messages: unknown[] = [];
    for (let index = 0; index < text.length; index += 5000) messages.push({ type: 'text', text: text.slice(index, index + 5000), ...(index === 0 && msg.quickReplies?.length ? { quickReply: { items: msg.quickReplies.slice(0, 13).map(label => ({ type: 'action', action: { type: 'message', label: label.slice(0, 20), text: label } })) } } : {}) });
    for (const attachment of msg.attachments ?? []) if (attachment.url.startsWith('https://')) messages.push(attachment.type === 'Image' ? { type: 'image', originalContentUrl: attachment.url, previewImageUrl: attachment.url } : attachment.type === 'Video' ? { type: 'video', originalContentUrl: attachment.url, previewImageUrl: attachment.url } : attachment.type === 'Audio' ? { type: 'audio', originalContentUrl: attachment.url, duration: 1000 } : { type: 'text', text: attachment.url });
    if (!messages.length) return { delivered: true };
    let start=0;
    if(msg.replyToken){const reply=await fetch('https://api.line.me/v2/bot/message/reply',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({replyToken:msg.replyToken,messages:messages.slice(0,5)}),signal:AbortSignal.timeout(15_000)});if(reply.ok)start=5;else if(![400,401,404].includes(reply.status))throw new Error(`LINE reply failed: HTTP ${reply.status}`);}
    for (let i = start; i < messages.length; i += 5) {
      const response = await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ to: msg.userId, messages: messages.slice(i, i + 5) }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`LINE push failed: HTTP ${response.status} ${await response.text()}`.slice(0, 500));
    }
    return { delivered: true };
  }
  async fetchUserProfile(userId: string, cfg: ChannelConfig) { const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, { headers: { authorization: `Bearer ${cfg.credentials.channelAccessToken}` }, signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`LINE profile failed: HTTP ${response.status}`); const body = await response.json() as { displayName?: string; pictureUrl?: string }; return { nickname: body.displayName, image: body.pictureUrl }; }
  async healthCheck(cfg: ChannelConfig) { return { ok: Boolean(cfg.credentials.channelSecret && cfg.credentials.channelAccessToken), detail: cfg.credentials.channelSecret && cfg.credentials.channelAccessToken ? 'Configured' : 'Missing LINE credentials' }; }
}
