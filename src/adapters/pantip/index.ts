import type { ChannelConfig } from '../../core/config.js';
import type { Attachment, ChannelAdapter, InboundEvent, OutboundEvent, RawRequest, SendResult } from '../../core/types.js';
import { verifyHmac } from '../../core/signature.js';

type PantipEvent = {
  id?: string;
  eventId?: string;
  userId?: string;
  memberId?: string;
  author?: { id?: string; name?: string; avatarUrl?: string };
  text?: string;
  message?: string;
  comment?: string;
  timestamp?: string | number;
  topicId?: string;
  conversationId?: string;
  attachments?: Attachment[];
};

/** Contract adapter for an endpoint approved through Pantip Certified Developer. */
export class PantipAdapter implements ChannelAdapter {
  readonly type = 'pantip' as const;
  readonly capabilities = { text:true, image:false, video:false, audio:false, file:false, quickReply:false, card:false, carousel:false, typing:false, readReceipt:false, maxTextLength:10_000, sessionWindowHours:null };

  async verifyWebhook(req:RawRequest,cfg:ChannelConfig):Promise<boolean> {
    const value=req.headers['x-pantip-signature-256']??req.headers['x-hub-signature-256'];
    return verifyHmac(req.rawBody,cfg.credentials.webhookSecret??'',typeof value==='string'?value:undefined,'hex','sha256=');
  }

  async parseInbound(req:RawRequest):Promise<InboundEvent[]> {
    const body=req.body as PantipEvent|{events?:PantipEvent[]};
    const items=body&&typeof body==='object'&&'events' in body&&Array.isArray(body.events)?body.events:[body as PantipEvent];
    return items.map((item,index)=>{
      const id=item.id??item.eventId;
      const userId=item.userId??item.memberId??item.author?.id;
      if(!id||!userId)throw new Error(`Pantip event ${index} requires id/eventId and userId/memberId/author.id`);
      const time=typeof item.timestamp==='number'?new Date(item.timestamp<10_000_000_000?item.timestamp*1000:item.timestamp).toISOString():item.timestamp??new Date().toISOString();
      return {id,userId,time,text:item.text??item.message??item.comment,attachments:item.attachments,conversationId:item.topicId??item.conversationId,profile:item.author?{nickname:item.author.name,image:item.author.avatarUrl}:undefined};
    });
  }

  async sendOutbound(msg:OutboundEvent,cfg:ChannelConfig):Promise<SendResult> {
    const url=cfg.credentials.outboundUrl;
    const token=cfg.credentials.accessToken;
    if(!url?.startsWith('https://'))throw new Error('Pantip certified outboundUrl must be HTTPS');
    if(!token)throw new Error('Pantip certified accessToken is required');
    const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({id:msg.id,recipientId:msg.userId,text:msg.text??'',replyToId:msg.replyToId}),signal:AbortSignal.timeout(15_000)});
    if(!response.ok)throw new Error(`Pantip send failed: HTTP ${response.status} ${await response.text()}`.slice(0,500));
    const result=await response.json().catch(()=>({})) as {id?:string};
    return {id:result.id,delivered:true};
  }

  async healthCheck(cfg:ChannelConfig) {
    const ok=Boolean(cfg.credentials.webhookSecret&&cfg.credentials.outboundUrl?.startsWith('https://')&&cfg.credentials.accessToken);
    return {ok,detail:ok?'Pantip certified connector configured':'Pantip Certified Developer webhook secret, HTTPS outbound URL, and access token required'};
  }
}
