import { timingSafeEqual } from 'node:crypto';
import type { ChannelConfig } from '../../core/config.js';
import type { ChannelAdapter, InboundEvent, OutboundEvent, RawRequest, SendResult } from '../../core/types.js';

type TelegramMessage={message_id:number;date:number;from?:{id:number;first_name?:string;last_name?:string;username?:string};chat:{id:number};text?:string;photo?:Array<{file_id:string}>;video?:{file_id:string};audio?:{file_id:string};document?:{file_id:string}};
type TelegramUpdate={update_id:number;message?:TelegramMessage;edited_message?:TelegramMessage};
export class TelegramAdapter implements ChannelAdapter {
  readonly type='telegram' as const;
  readonly capabilities={text:true,image:false,video:false,audio:false,file:false,quickReply:false,card:false,carousel:false,typing:false,readReceipt:false,maxTextLength:4096,sessionWindowHours:null};
  async verifyWebhook(req:RawRequest,cfg:ChannelConfig):Promise<boolean>{const supplied=req.headers['x-telegram-bot-api-secret-token'];const secret=cfg.credentials.webhookSecret??'';if(typeof supplied!=='string'||!secret)return false;const a=Buffer.from(supplied);const b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b);}
  async parseInbound(req:RawRequest):Promise<InboundEvent[]>{const update=req.body as TelegramUpdate;const msg=update.message??update.edited_message;if(!msg)return [];const media=msg.photo?.at(-1)?.file_id??msg.video?.file_id??msg.audio?.file_id??msg.document?.file_id;const type=msg.photo?'Image' as const:msg.video?'Video' as const:msg.audio?'Audio' as const:'File' as const;return [{id:String(update.update_id),userId:String(msg.chat.id),time:new Date(msg.date*1000).toISOString(),text:msg.text,profile:{firstName:msg.from?.first_name,lastName:msg.from?.last_name,nickname:msg.from?.username},attachments:media?[{type,url:`telegram-file:${media}`}]:undefined}];}
  async sendOutbound(msg:OutboundEvent,cfg:ChannelConfig):Promise<SendResult>{const token=cfg.credentials.botToken;if(!token)throw new Error('Telegram botToken missing');const text=[msg.text,...(msg.quickReplies??[]).map((x,i)=>`${i+1}. ${x}`),...(msg.cards??[]).map(c=>`${c.title}\n${c.description??''}\n${c.url??''}`)].filter(Boolean).join('\n');for(let i=0;i<text.length;i+=4096){const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:msg.userId,text:text.slice(i,i+4096)}),signal:AbortSignal.timeout(15_000)});if(!response.ok)throw new Error(`Telegram send failed: HTTP ${response.status}`);}return {delivered:true};}
  async healthCheck(cfg:ChannelConfig){return {ok:Boolean(cfg.credentials.botToken&&cfg.credentials.webhookSecret),detail:'Telegram bot token and webhook secret required'};}
}
