import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pino from 'pino';
import { appSchema, appStore, channelSchema, channelStore, genesysSchema, genesysStore, initializeConfig, loadPreviousSecretBox, loadSecretBox } from './core/config.js';
import { ConfigSecrets } from './core/secrets.js';
import { getAdapter, adapterCapabilities } from './adapters/index.js';
import { verifyHmac } from './core/signature.js';
import { Router } from './core/router.js';
import { DurableQueue } from './core/queue.js';
import { changePassword, initializeAdmin, registerAuth, requireAdmin, verifyAdminPassword } from './web/auth.js';
import { listMessages, pruneMessages } from './core/messages.js';
import { sessionStore } from './core/session.js';
import { GenesysClient } from './genesys/client.js';
import { MediaStore } from './core/media.js';
import { PollingService } from './core/polling.js';
import { RotatingFileStream } from './core/logging.js';
import type { OutboundEvent, RawRequest } from './core/types.js';
import { randomBytes } from 'node:crypto';
import { exchangeYoutubeCode, rememberYoutubeAccessToken, youtubeAuthorizationUrl } from './adapters/youtube/oauth.js';

type QueuePayload={kind:'send';channelId:string;event:OutboundEvent;integrationId:string;raw:Record<string,unknown>}|{kind:'receipt';integrationId:string;raw:Record<string,unknown>;status:'Delivered'|'Failed';reason?:string};
type WebhookBody={rawBody:Buffer;json:unknown};

/** Creates the HTTP app without listening, for tests and process startup. */
export async function createApp() {
  const box=await loadSecretBox();const previousBox=await loadPreviousSecretBox();await initializeConfig();await initializeAdmin();
  const config=await appStore.read();const secrets=new ConfigSecrets(box,previousBox);await secrets.finalizeRotation();await Promise.all([secrets.channels(),secrets.genesys()]);const media=new MediaStore();const router=new Router(secrets,media);
  const logDir=resolve(process.cwd(),'data/logs');await mkdir(logDir,{recursive:true});
  const fileLog=new RotatingFileStream(logDir);
  const logOptions={level:process.env.LOG_LEVEL??config.logLevel,redact:{paths:['req.headers.authorization','req.headers.cookie','*.clientSecret','*.webhookSecret','*.credentials','*.password'],censor:'[REDACTED]'}};
  // Scheduled Task stdout is not continuously drained. Writing every request to it eventually
  // fills the pipe and stalls the Node event loop, so production logs go directly to rotating files.
  const logger=process.env.NODE_ENV==='production'?pino(logOptions,fileLog):pino(logOptions,pino.multistream([{stream:(await import('pino-pretty')).default({colorize:true})},{stream:fileLog}]));
  const app=Fastify({loggerInstance:logger,bodyLimit:25_000_000});
  app.addHook('onClose',async()=>{fileLog.end();});
  await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"]}}});await app.register(cookie);
  let queue:DurableQueue<QueuePayload>;
  queue=new DurableQueue<QueuePayload>(async payload=>{if(payload.kind==='receipt'){await router.receipt(payload.integrationId,payload.raw,payload.status,payload.reason);return;}await router.deliver(payload.channelId,payload.event);await queue.enqueue({kind:'receipt',integrationId:payload.integrationId,raw:payload.raw,status:'Delivered'},5);},async(item,error)=>{if(item.payload.kind==='send'&&item.attempts>item.maxRetries)await queue.enqueue({kind:'receipt',integrationId:item.payload.integrationId,raw:item.payload.raw,status:'Failed',reason:error.message},5);});await queue.start();app.addHook('onClose',async()=>queue.stop());
  const polling=new PollingService(secrets,router);polling.start();app.addHook('onClose',async()=>polling.stop());
  const mediaCleanup=setInterval(()=>{void media.cleanup().catch(error=>app.log.error({err:error},'Media cleanup failed'));},60*60_000);app.addHook('onClose',async()=>clearInterval(mediaCleanup));
  const logCleanup=setInterval(()=>{void appStore.read().then(current=>Promise.all([fileLog.prune(current.retentionDays),pruneMessages(current.retentionDays)])).catch(error=>app.log.error({err:error},'Log retention failed'));},24*60*60_000);app.addHook('onClose',async()=>clearInterval(logCleanup));
  app.get('/health',async()=>({status:'ok'}));
  app.get('/media/:token',async(request,reply)=>{const {token}=request.params as {token:string};const item=await media.read(token);return item?reply.type(item.mimeType).send(item.bytes):reply.code(404).send({error:'Media not found'});});
  app.get('/health/detailed',async()=>{const channels=await secrets.channels();const integrations=await secrets.genesys();return {status:'ok',uptimeSeconds:Math.floor(process.uptime()),integrationsConfigured:integrations.length,channelsConfigured:channels.length,queueDepth:queue.list().length,channels:await Promise.all(channels.map(async x=>({id:x.id,type:x.type,enabled:x.enabled,...await getAdapter(x.type).healthCheck(x)}))),genesys:integrations.map(x=>({id:x.id,tokenStatus:new GenesysClient(x).tokenStatus()}))};});
  await app.register(registerAuth);
  const youtubeOAuthStates=new Map<string,{channelId:string;expiresAt:number}>();
  const youtubeRedirectUri=()=>new URL('/api/oauth/youtube/callback',(config.publicBaseUrl||'http://localhost:3000').replace(/\/$/,'')+'/').toString();
  app.get('/api/oauth/youtube/callback',async(request,reply)=>{
    const query=request.query as {state?:string;code?:string;error?:string};const pending=query.state?youtubeOAuthStates.get(query.state):undefined;
    if(query.state)youtubeOAuthStates.delete(query.state);
    if(!pending||pending.expiresAt<Date.now())return reply.code(400).type('text/plain').send('YouTube OAuth state is invalid or expired. Return to the bridge and try Connect YouTube again.');
    if(query.error||!query.code)return reply.redirect(`/?youtubeOAuth=${encodeURIComponent(query.error??'missing_code')}`);
    const channel=(await secrets.channels()).find(x=>x.id===pending.channelId&&x.type==='youtube');
    if(!channel)return reply.code(404).type('text/plain').send('YouTube channel configuration no longer exists.');
    const clientId=channel.credentials.oauthClientId;const clientSecret=channel.credentials.oauthClientSecret;
    if(!clientId||!clientSecret)return reply.code(400).type('text/plain').send('YouTube OAuth client credentials are missing.');
    try{const token=await exchangeYoutubeCode(clientId,clientSecret,query.code,youtubeRedirectUri());if(!token.refreshToken&&!channel.credentials.refreshToken)throw new Error('Google did not return a refresh token; reconnect and grant consent');await secrets.saveChannel({...channel,credentials:{...channel.credentials,accessToken:token.accessToken,refreshToken:token.refreshToken??channel.credentials.refreshToken}});rememberYoutubeAccessToken(channel.id,token.accessToken,token.expiresIn);return reply.redirect('/?youtubeOAuth=connected');}
    catch(error){app.log.warn({err:error,channelId:channel.id},'YouTube OAuth callback failed');return reply.redirect(`/?youtubeOAuth=${encodeURIComponent(error instanceof Error?error.message:'failed')}`);}
  });

  await app.register(async webhooks=>{
    webhooks.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>{try{const rawBody=body as Buffer;done(null,{rawBody,json:JSON.parse(rawBody.toString('utf8'))} satisfies WebhookBody);}catch(error){done(error as Error,undefined);}});
    for(const mime of ['text/xml','application/xml'])webhooks.addContentTypeParser(mime,{parseAs:'buffer'},(_request,body,done)=>{const rawBody=body as Buffer;done(null,{rawBody,json:null} satisfies WebhookBody);});
    webhooks.get('/webhooks/channel/:channelId',async(request,reply)=>{const {channelId}=request.params as {channelId:string};const cfg=(await secrets.channels()).find(x=>x.id===channelId&&x.enabled);if(!cfg)return reply.code(404).send({error:'Unknown channel'});const query=request.query as Record<string,string>;const challenge=getAdapter(cfg.type).handleChallenge?.({headers:request.headers,rawBody:Buffer.alloc(0),body:null,query},cfg);return challenge?reply.code(challenge.status).type('text/plain').send(challenge.body):reply.code(403).send({error:'Challenge rejected'});});
    webhooks.post('/webhooks/channel/:channelId',async(request,reply)=>{const {channelId}=request.params as {channelId:string};const cfg=(await secrets.channels()).find(x=>x.id===channelId&&x.enabled);if(!cfg)return reply.code(404).send({error:'Unknown channel'});const payload=request.body as WebhookBody;const raw:RawRequest={headers:request.headers,rawBody:payload.rawBody,body:payload.json,query:request.query as Record<string,string>};const adapter=getAdapter(cfg.type);if(!await adapter.verifyWebhook(raw,cfg))return reply.code(401).send({error:'Invalid signature'});const events=await adapter.parseInbound(raw,cfg);for(const event of events)await router.inbound(cfg,event);return {accepted:events.length};});
    webhooks.post('/webhooks/genesys/:integrationId',async(request,reply)=>{const {integrationId}=request.params as {integrationId:string};const cfg=(await secrets.genesys()).find(x=>x.integrationId===integrationId);if(!cfg)return reply.code(404).send({error:'Unknown integration'});const payload=request.body as WebhookBody;const signature=request.headers['x-hub-signature-256'];if(cfg.verifySignature&&!verifyHmac(payload.rawBody,cfg.webhookSecret,typeof signature==='string'?signature:undefined,'hex','sha256='))return reply.code(401).send({error:'Invalid signature'});const body=payload.json as Record<string,unknown>;const target=((body.channel as Record<string,unknown>|undefined)?.to as Record<string,unknown>|undefined)?.id;if(typeof target!=='string'||target.split(':').length<3)return reply.code(200).send({accepted:false,ignored:true});const route=await router.outbound(integrationId,body);const channel=(await secrets.channels()).find(x=>x.id===route.channelId);await queue.enqueue({kind:'send',...route},channel?.maxRetries??5);return reply.code(200).send({accepted:true});});
  });

  await app.register(async admin=>{
    admin.addHook('preHandler',requireAdmin);
    admin.get('/api/admin/overview',async()=>{const channels=await secrets.channels();const records=await listMessages(1000);const recent=records.filter(x=>Date.now()-new Date(x.time).getTime()<60_000);return {channels:channels.length,integrations:(await secrets.genesys()).length,queueDepth:queue.list().length,dlqSize:(await queue.deadLetters()).length,uptimeSeconds:Math.floor(process.uptime()),inboundPerMinute:recent.filter(x=>x.direction==='inbound').length,outboundPerMinute:recent.filter(x=>x.direction==='outbound').length,errorsPerMinute:recent.filter(x=>x.status==='failed'||x.error).length,recentErrors:records.filter(x=>x.error).slice(0,5),channelStatus:await Promise.all(channels.map(async x=>({id:x.id,name:x.name,enabled:x.enabled,...await getAdapter(x.type).healthCheck(x)}))),capabilities:adapterCapabilities()};});
    admin.get('/api/admin/channels',async()=>({items:(await secrets.channels()).map(x=>({...x,credentials:Object.fromEntries(Object.entries(x.credentials).map(([k,v])=>[k,ConfigSecrets.mask(v)]))})),capabilities:adapterCapabilities()}));
    admin.put('/api/admin/channels/:id',async(request,reply)=>{const {id}=request.params as {id:string};const parsed=channelSchema.safeParse({...request.body as object,id});if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});getAdapter(parsed.data.type);await secrets.saveChannel(parsed.data);return {ok:true};});
    admin.delete('/api/admin/channels/:id',async(request)=>{const {id}=request.params as {id:string};await channelStore.write((await channelStore.read()).filter(x=>x.id!==id));return {ok:true};});
    admin.post('/api/admin/channels/:id/test',async(request,reply)=>{const {id}=request.params as {id:string};const cfg=(await secrets.channels()).find(x=>x.id===id);if(!cfg)return reply.code(404).send({error:'Unknown channel'});return getAdapter(cfg.type).healthCheck(cfg);});
    admin.get('/api/admin/channels/:id/youtube/connect',async(request,reply)=>{const {id}=request.params as {id:string};const cfg=(await secrets.channels()).find(x=>x.id===id&&x.type==='youtube');if(!cfg)return reply.code(404).send({error:'Unknown YouTube channel'});if(cfg.options.youtubeAuthMode==='apiKey')return reply.code(400).send({error:'Switch this YouTube channel to OAuth 2.0 before connecting'});if(!cfg.credentials.oauthClientId||!cfg.credentials.oauthClientSecret)return reply.code(400).send({error:'Save the Google OAuth client ID and secret first'});const state=randomBytes(32).toString('base64url');youtubeOAuthStates.set(state,{channelId:id,expiresAt:Date.now()+10*60_000});return reply.redirect(youtubeAuthorizationUrl(cfg.credentials.oauthClientId,youtubeRedirectUri(),state));});
    admin.get('/api/admin/genesys',async()=>({items:(await secrets.genesys()).map(x=>({...x,clientSecret:ConfigSecrets.mask(x.clientSecret),webhookSecret:ConfigSecrets.mask(x.webhookSecret)}))}));
    admin.put('/api/admin/genesys/:id',async(request,reply)=>{const {id}=request.params as {id:string};const parsed=genesysSchema.safeParse({...request.body as object,id});if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});await secrets.saveGenesys(parsed.data);return {ok:true};});
    admin.delete('/api/admin/genesys/:id',async(request)=>{const {id}=request.params as {id:string};await genesysStore.write((await genesysStore.read()).filter(x=>x.id!==id));return {ok:true};});
    admin.post('/api/admin/genesys/:id/test',async(request,reply)=>{const {id}=request.params as {id:string};const cfg=(await secrets.genesys()).find(x=>x.id===id);if(!cfg)return reply.code(404).send({error:'Unknown integration'});await new GenesysClient(cfg).accessToken();return {ok:true};});
    admin.get('/api/admin/messages',async()=>({items:await listMessages()}));
    admin.get('/api/admin/sessions',async()=>({items:await sessionStore.read()}));
    admin.delete('/api/admin/sessions/:channelId/:userId',async(request)=>{const {channelId,userId}=request.params as {channelId:string;userId:string};await sessionStore.write((await sessionStore.read()).filter(x=>x.channelId!==channelId||x.userId!==userId));return {ok:true};});
    admin.get('/api/admin/queue',async()=>({items:queue.list(),deadLetters:await queue.deadLetters()}));
    admin.post('/api/admin/queue/:id/retry',async(request,reply)=>{const {id}=request.params as {id:string};return await queue.retry(id)?{ok:true}:reply.code(404).send({error:'Unknown queue item'});});
    admin.post('/api/admin/queue/retry-all',async()=>({count:await queue.retryAll()}));
    admin.delete('/api/admin/queue',async()=>({count:await queue.purge()}));
    admin.post('/api/admin/dlq/:id/retry',async(request,reply)=>{const {id}=request.params as {id:string};return await queue.retryDead(id)?{ok:true}:reply.code(404).send({error:'Unknown dead letter'});});
    admin.delete('/api/admin/dlq',async()=>({count:await queue.purgeDead()}));
    admin.get('/api/admin/settings',async()=>({...(await appStore.read()),adminPasswordHash:'[REDACTED]',sessionSecret:'[REDACTED]'}));
    admin.put('/api/admin/settings',async(request,reply)=>{const previous=await appStore.read();const parsed=appSchema.safeParse({...previous,...request.body as object,adminPasswordHash:previous.adminPasswordHash,sessionSecret:previous.sessionSecret});if(!parsed.success)return reply.code(400).send({error:parsed.error.flatten()});await appStore.write(parsed.data);app.log.level=parsed.data.logLevel;return {ok:true};});
    admin.post('/api/admin/password',async(request,reply)=>{const body=request.body as {current?:string;next?:string};if(!body?.current||!body.next)return reply.code(400).send({error:'Current and new password required'});if(!await changePassword(body.current,body.next))return reply.code(403).send({error:'Current password incorrect'});return {ok:true};});
    admin.post('/api/admin/encryption/rotate',async(request,reply)=>{const body=request.body as {password?:string};if(!body?.password||!await verifyAdminPassword(body.password))return reply.code(403).send({error:'Re-authentication required'});await secrets.rotateKey();return {ok:true};});
    admin.post('/api/admin/reveal',async(request,reply)=>{const body=request.body as {password?:string;kind?:'channel'|'genesys';id?:string};if(!body?.password||!await verifyAdminPassword(body.password))return reply.code(403).send({error:'Re-authentication required'});if(body.kind==='channel'){const item=(await secrets.channels()).find(x=>x.id===body.id);return item?{credentials:item.credentials}:reply.code(404).send({error:'Unknown channel'});}if(body.kind==='genesys'){const item=(await secrets.genesys()).find(x=>x.id===body.id);return item?{clientSecret:item.clientSecret,webhookSecret:item.webhookSecret}:reply.code(404).send({error:'Unknown integration'});}return reply.code(400).send({error:'Invalid reveal target'});});
    admin.get('/api/admin/export',async()=>{const current=await appStore.read();const {adminPasswordHash:_password,sessionSecret:_session,...publicApp}=current;return {version:1,app:publicApp,channels:await channelStore.read(),genesys:await genesysStore.read()};});
    admin.post('/api/admin/import',async(request,reply)=>{const body=request.body as {version?:number;app?:unknown;channels?:unknown;genesys?:unknown};if(body?.version!==1||!Array.isArray(body.channels)||!Array.isArray(body.genesys))return reply.code(400).send({error:'Invalid export format'});const previous=await appStore.read();const appParse=appSchema.safeParse({...previous,...body.app as object,adminPasswordHash:previous.adminPasswordHash,sessionSecret:previous.sessionSecret});const channelsParse=channelSchema.array().safeParse(body.channels);const genesysParse=genesysSchema.array().safeParse(body.genesys);if(!appParse.success||!channelsParse.success||!genesysParse.success)return reply.code(400).send({error:'Invalid configuration data'});try{for(const item of channelsParse.data)for(const value of Object.values(item.credentials))if(value.startsWith('enc:v1:'))secrets.validateCiphertext(value);for(const item of genesysParse.data)for(const value of [item.clientSecret,item.webhookSecret])if(value.startsWith('enc:v1:'))secrets.validateCiphertext(value);}catch{return reply.code(400).send({error:'Encrypted credentials require the same APP_ENCRYPTION_KEY'});}await appStore.write(appParse.data);await channelStore.write(channelsParse.data);await genesysStore.write(genesysParse.data);return {ok:true};});
  });

  const ui=resolve(process.cwd(),'web/dist');if(existsSync(ui))await app.register(fastifyStatic,{root:ui,wildcard:false});else app.get('/',async(_request,reply)=>reply.type('text/html').send('<h1>Build the admin UI with npm run build.</h1>'));
  return {app,config};
}

if(process.env.NODE_ENV!=='test'){
  const {app,config}=await createApp();const port=Number(process.env.PORT??config.port);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535');
  await app.listen({host:process.env.HOST??'0.0.0.0',port});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
}
