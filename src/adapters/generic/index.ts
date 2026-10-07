import type { ChannelConfig } from '../../core/config.js';
import type { ChannelAdapter, InboundEvent, OutboundEvent, RawRequest, SendResult } from '../../core/types.js';
import { verifyHmac } from '../../core/signature.js';

export class GenericAdapter implements ChannelAdapter {
  readonly type = 'generic' as const;
  readonly capabilities = { text:true, image:true, video:true, audio:true, file:true, quickReply:false, card:false, carousel:false, typing:false, readReceipt:false, maxTextLength:4000, sessionWindowHours:null };
  async verifyWebhook(req:RawRequest,cfg:ChannelConfig):Promise<boolean> { const header=req.headers['x-hub-signature-256']; return verifyHmac(req.rawBody,cfg.credentials.webhookSecret ?? '',typeof header==='string'?header:undefined,'hex','sha256='); }
  async parseInbound(req:RawRequest):Promise<InboundEvent[]> { const body=req.body as { id?:string; userId?:string; text?:string; time?:string; kind?:string }; if (!body.id || !body.userId) throw new Error('Generic webhook needs id and userId'); return [{ id:body.id,userId:body.userId,text:body.text,time:body.time ?? new Date().toISOString(),kind:body.kind==='typing'?'typing':'message' }]; }
  async sendOutbound(msg:OutboundEvent,cfg:ChannelConfig):Promise<SendResult> { const url=cfg.credentials.outboundUrl; if (!url?.startsWith('https://')) throw new Error('Generic outboundUrl must be HTTPS'); const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${cfg.credentials.outboundToken ?? ''}`},body:JSON.stringify(msg),signal:AbortSignal.timeout(15_000)}); if(!response.ok) throw new Error(`Generic send failed: HTTP ${response.status}`); return {delivered:true}; }
  async healthCheck(cfg:ChannelConfig) { return {ok:Boolean(cfg.credentials.webhookSecret && cfg.credentials.outboundUrl),detail:'Generic webhook secret and outbound URL required'}; }
}
