import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyHmac } from '../src/core/signature.js';
import { GenesysClient } from '../src/genesys/client.js';
import { LineAdapter } from '../src/adapters/line/index.js';
import { MetaAdapter } from '../src/adapters/meta/index.js';
import { WhatsAppAdapter } from '../src/adapters/whatsapp/index.js';
import { TelegramAdapter } from '../src/adapters/telegram/index.js';
import { TikTokAdapter } from '../src/adapters/tiktok/index.js';
import { WeChatAdapter } from '../src/adapters/wechat/index.js';
import { GenericAdapter } from '../src/adapters/generic/index.js';
import { PantipAdapter } from '../src/adapters/pantip/index.js';
import { youtubeAccessToken } from '../src/adapters/youtube/oauth.js';
import { YouTubeAdapter } from '../src/adapters/youtube/index.js';
import { DurableQueue } from '../src/core/queue.js';
import type { ChannelConfig, GenesysConfig } from '../src/core/config.js';

const channel:ChannelConfig={id:'line-1',type:'line',name:'Test',enabled:true,integrationId:'g1',credentials:{channelSecret:'secret',channelAccessToken:'token'},options:{},maxRetries:5,rateLimitRps:5};
const genesys:GenesysConfig={id:'g1',name:'Test',region:'mypurecloud.com',clientId:'client',clientSecret:'secret',integrationId:'a4fac3cc-c30c-47cd-a065-293897e2d508',webhookSecret:'hook',verifySignature:true};

describe('webhook signatures',()=>{
  it('checks the exact raw bytes and rejects changed content',()=>{const raw=Buffer.from('{"text":"a b"}');const signature=`sha256=${createHmac('sha256','secret').update(raw).digest('hex')}`;expect(verifyHmac(raw,'secret',signature,'hex','sha256=')).toBe(true);expect(verifyHmac(Buffer.from('{"text":"a  b"}'),'secret',signature,'hex','sha256=')).toBe(false);});
  it('verifies LINE base64 signature',async()=>{const raw=Buffer.from('{"events":[]}');const signature=createHmac('sha256','secret').update(raw).digest('base64');expect(await new LineAdapter().verifyWebhook({rawBody:raw,body:{events:[]},headers:{'x-line-signature':signature}},channel)).toBe(true);});
  it('verifies Meta, WhatsApp, and generic HMAC signatures',async()=>{const raw=Buffer.from('{}');const signature=`sha256=${createHmac('sha256','secret').update(raw).digest('hex')}`;const req={rawBody:raw,body:{},headers:{'x-hub-signature-256':signature}};const cfg={...channel,credentials:{appSecret:'secret',webhookSecret:'secret'}};expect(await new MetaAdapter('facebook').verifyWebhook(req,cfg)).toBe(true);expect(await new MetaAdapter('instagram').verifyWebhook(req,cfg)).toBe(true);expect(await new WhatsAppAdapter().verifyWebhook(req,cfg)).toBe(true);expect(await new GenericAdapter().verifyWebhook(req,cfg)).toBe(true);});
  it('verifies and parses Pantip certified connector events',async()=>{const body={eventId:'comment-1',memberId:'member-1',comment:'hello',topicId:'topic-1',timestamp:1_790_000_000};const raw=Buffer.from(JSON.stringify(body));const signature=`sha256=${createHmac('sha256','secret').update(raw).digest('hex')}`;const adapter=new PantipAdapter();const cfg={...channel,type:'pantip' as const,credentials:{webhookSecret:'secret',outboundUrl:'https://partner.example/replies',accessToken:'token'}};expect(await adapter.verifyWebhook({rawBody:raw,body,headers:{'x-pantip-signature-256':signature}},cfg)).toBe(true);expect(await adapter.parseInbound({rawBody:raw,body,headers:{}})).toMatchObject([{id:'comment-1',userId:'member-1',text:'hello',conversationId:'topic-1'}]);});
  it('verifies Telegram secret and TikTok timestamp signatures',async()=>{const raw=Buffer.from('{}');expect(await new TelegramAdapter().verifyWebhook({rawBody:raw,body:{},headers:{'x-telegram-bot-api-secret-token':'secret'}},{...channel,credentials:{webhookSecret:'secret'}})).toBe(true);const timestamp=Math.floor(Date.now()/1000);const signature=createHmac('sha256','secret').update(`${timestamp}.`).update(raw).digest('hex');expect(await new TikTokAdapter().verifyWebhook({rawBody:raw,body:{},headers:{'tiktok-signature':`t=${timestamp},s=${signature}`}},{...channel,credentials:{clientSecret:'secret'}})).toBe(true);});
  it('verifies WeChat plaintext challenge signatures',async()=>{const timestamp='123';const nonce='456';const {createHash}=await import('node:crypto');const signature=createHash('sha1').update(['secret',timestamp,nonce].sort().join('')).digest('hex');const req={rawBody:Buffer.from('<xml></xml>'),body:null,headers:{},query:{timestamp,nonce,signature,echostr:'challenge'}};expect(await new WeChatAdapter().verifyWebhook(req,{...channel,credentials:{verifyToken:'secret'}})).toBe(true);expect(new WeChatAdapter().handleChallenge(req,{...channel,credentials:{verifyToken:'secret'}})?.body).toBe('challenge');});
});

describe('Genesys client',()=>{
  it('caches OAuth tokens and retries one 401',async()=>{const calls:string[]=[];let apiCalls=0;const transport:typeof fetch=async(input,init)=>{calls.push(String(input));if(String(input).includes('/oauth/token'))return new Response(JSON.stringify({access_token:`token-${calls.length}`,expires_in:3600}),{status:200});apiCalls++;return apiCalls===1?new Response('unauthorized',{status:401}):new Response('{}',{status:200});};const client=new GenesysClient(genesys,transport);await client.sendMessage({id:'event',userId:'user',time:'2026-01-01T00:00:00Z',text:'hello'},'line','line-1','business');expect(apiCalls).toBe(2);expect(calls.filter(x=>x.includes('/oauth/token'))).toHaveLength(2);});
  it('creates stable globally unique IDs',()=>{const event={id:'a',userId:'u',time:'2026-01-01T00:00:00Z',text:'hi'};const a=GenesysClient.normalizeInbound(event,'line','one','business');const b=GenesysClient.normalizeInbound(event,'line','two','business');expect((a.channel as {from:{id:string}}).from.id).toBe('line:one:u');expect((a.channel as {messageId:string}).messageId).not.toBe((b.channel as {messageId:string}).messageId);});
});

describe('YouTube OAuth',()=>{
  it('exchanges a stored refresh token for an access token',async()=>{const transport=vi.fn(async()=>new Response(JSON.stringify({access_token:'renewed',expires_in:3600}),{status:200}));vi.stubGlobal('fetch',transport);try{const token=await youtubeAccessToken({...channel,id:'youtube-oauth-test',type:'youtube',credentials:{oauthClientId:'client',oauthClientSecret:'secret',refreshToken:'refresh'}});expect(token).toBe('renewed');expect(String(transport.mock.calls[0]?.[1]?.body)).toContain('grant_type=refresh_token');}finally{vi.unstubAllGlobals();}});
  it('polls comments with OAuth when no API key is configured',async()=>{const transport=vi.fn(async(input:unknown)=>String(input).includes('oauth2.googleapis.com')?new Response(JSON.stringify({access_token:'oauth-token',expires_in:3600}),{status:200}):new Response(JSON.stringify({items:[]}),{status:200}));vi.stubGlobal('fetch',transport);try{await new YouTubeAdapter().poll({...channel,id:'youtube-poll-oauth',type:'youtube',credentials:{channelId:'UC123',oauthClientId:'client',oauthClientSecret:'secret',refreshToken:'refresh'}});expect(transport).toHaveBeenCalledTimes(2);expect(transport.mock.calls[1]?.[1]?.headers).toMatchObject({authorization:'Bearer oauth-token'});expect(String(transport.mock.calls[1]?.[0])).not.toContain('key=');}finally{vi.unstubAllGlobals();}});
  it('uses only the API key in read-only API-key mode',async()=>{const transport=vi.fn(async()=>new Response(JSON.stringify({items:[]}),{status:200}));vi.stubGlobal('fetch',transport);try{const cfg={...channel,id:'youtube-poll-key',type:'youtube' as const,options:{youtubeAuthMode:'apiKey'},credentials:{channelId:'UC123',apiKey:'key-only'}};await new YouTubeAdapter().poll(cfg);expect(transport).toHaveBeenCalledTimes(1);expect(String(transport.mock.calls[0]?.[0])).toContain('key=key-only');await expect(new YouTubeAdapter().sendOutbound({id:'reply',userId:'u',replyToId:'c',text:'hello'},cfg)).rejects.toThrow('read-only');}finally{vi.unstubAllGlobals();}});
});

describe('retry timing',()=>{it('increases exponential delay within the cap',()=>{expect(DurableQueue.backoff(2,0)).toBe(4000);expect(DurableQueue.backoff(3,0)).toBe(8000);expect(DurableQueue.backoff(20,0)).toBeLessThanOrEqual(300000);});});
