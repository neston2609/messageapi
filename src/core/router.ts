import { appStore, type ChannelConfig } from './config.js';
import type { InboundEvent, OutboundEvent } from './types.js';
import { ConfigSecrets } from './secrets.js';
import { getAdapter } from '../adapters/index.js';
import { GenesysClient } from '../genesys/client.js';
import { DedupStore } from './dedup.js';
import { sessionStore, touchSession } from './session.js';
import { recordMessage } from './messages.js';
import { MediaStore } from './media.js';
import { WeChatAdapter } from '../adapters/wechat/index.js';

export function isOutsideBusinessHours(options:Record<string,unknown>,now=new Date()):boolean{
  const start=options.businessHoursStart;const end=options.businessHoursEnd;const zone=options.businessHoursTimeZone;
  const mode=options.businessHoursMode??(typeof start==='string'&&start&&typeof end==='string'&&end?'scheduled':'always');
  if(mode!=='scheduled')return false;
  if(typeof start!=='string'||!start||typeof end!=='string'||!end||typeof zone!=='string'||!zone)throw new Error('Custom business hours require start, end, and time zone');
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
  const day=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short'}).format(now);
  return ['Sat','Sun'].includes(day)||time<start||time>=end;
}

export class Router {
  private readonly dedup=new DedupStore();
  private readonly rate=new Map<string,{tokens:number;updated:number}>();
  private readonly circuit=new Map<string,{failures:number;openUntil:number}>();
  constructor(private readonly config:ConfigSecrets,private readonly media:MediaStore){}
  async inbound(channel:ChannelConfig,event:InboundEvent):Promise<void>{
    const key=`${channel.type}:${channel.id}:${event.id}`;if(await this.dedup.has(key))return;
    const genesys=(await this.config.genesys()).find(x=>x.id===channel.integrationId);if(!genesys)throw new Error(`No Genesys integration bound to ${channel.id}`);
    const adapter=getAdapter(channel.type);if(adapter.fetchUserProfile&&!event.profile)try{event.profile=await adapter.fetchUserProfile(event.userId,channel);}catch(error){await recordMessage({time:new Date().toISOString(),channelId:channel.id,direction:'inbound',status:'profile-error',messageId:event.id,raw:{userId:event.userId},normalized:{},error:error instanceof Error?error.message:String(error)});}
    const client=new GenesysClient(genesys);
    if(event.kind==='typing'){const channelBody={platform:'Open',type:'Private',messageId:GenesysClient.messageId(channel.type,channel.id,event.id),to:{id:genesys.integrationId},from:{id:`${channel.type}:${channel.id}:${event.userId}`,idType:'Opaque'},time:event.time};await client.sendEvent({channel:channelBody,type:'Event',eventType:'Typing'});await this.dedup.add(key,(await appStore.read()).dedupTtlHours*60*60_000);return;}
    const hosted={...event,attachments:await Promise.all((event.attachments??[]).map(async attachment=>{
      if(attachment.url.startsWith('line-content:'))return {...attachment,url:await this.media.download(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(attachment.url.slice(13))}/content`,{authorization:`Bearer ${channel.credentials.channelAccessToken}`})};
      if(attachment.url.startsWith('telegram-file:')){const token=channel.credentials.botToken;const response=await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(attachment.url.slice(14))}`);if(!response.ok)throw new Error(`Telegram getFile failed: HTTP ${response.status}`);const body=await response.json() as {result?:{file_path?:string}};if(!body.result?.file_path)throw new Error('Telegram file path missing');return {...attachment,url:await this.media.download(`https://api.telegram.org/file/bot${token}/${body.result.file_path}`)};}
      if(attachment.url.startsWith('whatsapp-media:')){const token=channel.credentials.accessToken;const response=await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(attachment.url.slice(15))}`,{headers:{authorization:`Bearer ${token}`}});if(!response.ok)throw new Error(`WhatsApp media lookup failed: HTTP ${response.status}`);const body=await response.json() as {url?:string};if(!body.url)throw new Error('WhatsApp media URL missing');return {...attachment,url:await this.media.download(body.url,{authorization:`Bearer ${token}`})};}
      if(attachment.url.startsWith('wechat-media:'))return {...attachment,url:await this.media.download(await new WeChatAdapter().mediaUrl(attachment.url.slice(13),channel))};
      return attachment;
    }))};
    const normalized=GenesysClient.normalizeInbound(hosted,channel.type,channel.id,genesys.integrationId);
    const hints=Object.fromEntries(['queueId','flowId'].filter(key=>typeof channel.options[key]==='string'&&channel.options[key]).map(key=>[key,channel.options[key]]));
    if(Object.keys(hints).length)(normalized.channel as Record<string,unknown>).metadata=hints;
    await client.sendNormalizedMessage(normalized);
    await this.dedup.add(key,(await appStore.read()).dedupTtlHours*60*60_000);const first=!(await sessionStore.read()).some(x=>x.channelId===channel.id&&x.userId===event.userId);await touchSession(channel.id,event.userId,event.conversationId,event.replyToken);
    let reply:unknown=first?channel.options.welcomeMessage:undefined;
    if(channel.options.outOfHoursMessage){try{if(isOutsideBusinessHours(channel.options))reply=channel.options.outOfHoursMessage;}catch(error){reply=undefined;await recordMessage({time:new Date().toISOString(),channelId:channel.id,direction:'outbound',status:'configuration-error',messageId:`auto:${event.id}`,raw:channel.options,normalized:{},error:error instanceof Error?error.message:String(error)});}}
    if(typeof reply==='string'&&reply)try{await getAdapter(channel.type).sendOutbound({id:`auto:${event.id}`,userId:event.userId,text:reply},channel);}catch(error){await recordMessage({time:new Date().toISOString(),channelId:channel.id,direction:'outbound',status:'failed',messageId:`auto:${event.id}`,raw:{text:reply},normalized:{text:reply},error:error instanceof Error?error.message:String(error)});}
    await recordMessage({time:new Date().toISOString(),channelId:channel.id,direction:'inbound',status:'sent',messageId:event.id,raw:event,normalized});
  }
  async outbound(integrationId:string,raw:Record<string,unknown>):Promise<{channelId:string;event:OutboundEvent;integrationId:string;raw:Record<string,unknown>}>{
    const channelObject=raw.channel as Record<string,unknown>|undefined;const target=channelObject?.to as Record<string,unknown>|undefined;
    const targetId=String(target?.id??'');const [type,channelId,...userParts]=targetId.split(':');const userId=userParts.join(':');
    if(!channelId||!userId)throw new Error('Outbound channel.to.id must be channelType:channelConfigId:platformUserId');
    const channel=(await this.config.channels()).find(x=>x.id===channelId && x.type===type && x.enabled);
    if(!channel)throw new Error(`Outbound channel ${channelId} is unavailable`);
    const genesys=(await this.config.genesys()).find(x=>x.id===channel.integrationId && x.integrationId===integrationId);
    if(!genesys)throw new Error('Channel is not bound to this Genesys integration');
    const session=(await sessionStore.read()).find(x=>x.channelId===channelId&&x.userId===userId);const replyToId=session?.conversationId;const replyToken=session?.replyTokenExpiresAt&&session.replyTokenExpiresAt>Date.now()?session.replyToken:undefined;
    const event:OutboundEvent={id:String(channelObject?.messageId??raw.id??crypto.randomUUID()),userId,text:typeof raw.text==='string'?raw.text:undefined,attachments:Array.isArray(raw.attachments)?raw.attachments as OutboundEvent['attachments']:undefined,quickReplies:Array.isArray(raw.quickReplies)?raw.quickReplies.filter((x):x is string=>typeof x==='string'):undefined,cards:Array.isArray(raw.cards)?raw.cards as OutboundEvent['cards']:undefined,replyToId,replyToken};
    return {channelId,event,integrationId,raw};
  }
  async receipt(integrationId:string,raw:Record<string,unknown>,status:'Delivered'|'Failed',reason?:string):Promise<void>{const cfg=(await this.config.genesys()).find(x=>x.integrationId===integrationId);if(!cfg)throw new Error('Genesys integration unavailable for receipt');const channel=raw.channel as Record<string,unknown>|undefined;await new GenesysClient(cfg).sendReceipt({id:raw.id??channel?.messageId,channel:{...channel,time:new Date().toISOString()},type:'Receipt',status,direction:'Outbound',isFinalReceipt:true,...(reason?{reason:reason.slice(0,300)}:{})});}
  async deliver(channelId:string,event:OutboundEvent):Promise<void>{
    const channel=(await this.config.channels()).find(x=>x.id===channelId&&x.enabled);if(!channel)throw new Error(`Channel ${channelId} unavailable`);
    const state=this.circuit.get(channelId);if(state&&state.openUntil>Date.now())throw new Error(`Circuit open for ${channelId}`);
    const now=Date.now();const capacity=Math.max(1,channel.rateLimitRps);const bucket=this.rate.get(channelId)??{tokens:capacity,updated:now};bucket.tokens=Math.min(capacity,bucket.tokens+(now-bucket.updated)/1000*channel.rateLimitRps);bucket.updated=now;if(bucket.tokens<1)throw new Error(`Rate limit reached for ${channelId}`);bucket.tokens--;this.rate.set(channelId,bucket);
    const adapter=getAdapter(channel.type);const caps=adapter.capabilities;
    const session=(await sessionStore.read()).find(x=>x.channelId===channelId&&x.userId===event.userId);
    const expired=caps.sessionWindowHours!==null&&(!session||Date.now()-new Date(session.lastActivity).getTime()>caps.sessionWindowHours*60*60_000);
    if(expired&&channel.type!=='whatsapp')throw new Error(`${channel.type} session window expired; an approved platform re-engagement method is required`);
    const supported=(event.attachments??[]).filter(x=>caps[x.type.toLowerCase() as 'image'|'video'|'audio'|'file']);
    const unsupported=(event.attachments??[]).filter(x=>!supported.includes(x));
    const fallback=[event.text,...(!caps.quickReply?(event.quickReplies??[]).map((x,i)=>`${i+1}. ${x}`):[]),...(!caps.card?(event.cards??[]).map(x=>`${x.title}\n${x.description??''}\n${x.url??''}`):[]),...unsupported.map(x=>x.url)].filter(Boolean).join('\n');
    const template=expired&&channel.type==='whatsapp'&&channel.credentials.fallbackTemplateName?{name:channel.credentials.fallbackTemplateName,language:channel.credentials.fallbackTemplateLanguage??'en_US'}:undefined;
    if(expired&&!template)throw new Error('WhatsApp session window expired; configure an approved fallback template');
    const prepared={...event,text:fallback,attachments:supported,quickReplies:caps.quickReply?event.quickReplies:undefined,cards:caps.card?event.cards:undefined,template};
    try{const textParts=prepared.template?['']:prepared.text?Array.from({length:Math.ceil(prepared.text.length/caps.maxTextLength)},(_,i)=>prepared.text!.slice(i*caps.maxTextLength,(i+1)*caps.maxTextLength)):[''];for(const [index,textPart] of textParts.entries()){const result=await adapter.sendOutbound({...prepared,text:textPart,attachments:index===0?prepared.attachments:[],quickReplies:index===0?prepared.quickReplies:undefined,cards:index===0?prepared.cards:undefined},channel);if(!result.delivered)throw new Error(result.error??'Channel delivery failed');}this.circuit.delete(channelId);await recordMessage({time:new Date().toISOString(),channelId,direction:'outbound',status:'delivered',messageId:event.id,raw:event,normalized:prepared});}
    catch(error){const previous=this.circuit.get(channelId);const failures=(previous?.failures??0)+1;this.circuit.set(channelId,{failures,openUntil:failures>=5?Date.now()+60_000:0});throw error;}
  }
}
