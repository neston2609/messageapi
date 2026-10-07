import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { appStore, dataDir } from '../core/config.js';

function sign(input: string, secret: string): string { return createHmac('sha256', secret).update(input).digest('base64url'); }
function equal(a: string, b: string): boolean { const x=Buffer.from(a); const y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }

export async function initializeAdmin(): Promise<void> {
  const config=await appStore.read();
  if (config.adminPasswordHash && config.sessionSecret) return;
  const password=randomBytes(18).toString('base64url');
  const next={...config,adminPasswordHash:await argon2.hash(password),sessionSecret:randomBytes(32).toString('base64url')};
  await appStore.write(next);
  await mkdir(resolve(dataDir,'config'),{recursive:true});
  await writeFile(resolve(dataDir,'config/first-run-admin.txt'),`Username: ${next.adminUsername}\nPassword: ${password}\nDelete this file after first login.\n`,{flag:'wx',mode:0o600});
}

export const registerAuth:FastifyPluginAsync=async app=>{
  const attempts=new Map<string,{count:number;until:number}>();
  app.post('/api/auth/login',async(request,reply)=>{
    const ip=request.ip; const state=attempts.get(ip); if(state && state.count>=5 && state.until>Date.now()) return reply.code(429).send({error:'Too many login attempts'});
    const body=request.body as {username?:string;password?:string}; const config=await appStore.read();
    const valid=body?.username===config.adminUsername && typeof body.password==='string' && await argon2.verify(config.adminPasswordHash,body.password);
    if(!valid){attempts.set(ip,{count:(state?.count??0)+1,until:Date.now()+15*60_000});return reply.code(401).send({error:'Invalid credentials'});}
    attempts.delete(ip);
    const payload=`${Date.now()+8*60*60_000}.${randomBytes(16).toString('hex')}`; const token=`${payload}.${sign(payload,config.sessionSecret)}`;
    reply.setCookie('bridge_session',token,{httpOnly:true,secure:config.publicBaseUrl.startsWith('https://'),sameSite:'strict',path:'/',maxAge:8*60*60});
    return {ok:true,csrf:sign(token,config.sessionSecret)};
  });
  app.post('/api/auth/logout',{preHandler:requireAdmin},async(_request,reply)=>{reply.clearCookie('bridge_session',{path:'/'});return {ok:true};});
  app.get('/api/auth/session',{preHandler:requireAdmin},async request=>({ok:true,csrf:sign(request.cookies.bridge_session ?? '', (await appStore.read()).sessionSecret)}));
}

export async function requireAdmin(request:FastifyRequest,reply:FastifyReply):Promise<void> {
  const config=await appStore.read(); const cookie=request.cookies.bridge_session; if(!cookie){reply.code(401).send({error:'Login required'});return;}
  const index=cookie.lastIndexOf('.'); const payload=cookie.slice(0,index); const signature=cookie.slice(index+1); const expires=Number(payload.split('.')[0]);
  if(index<0 || !Number.isFinite(expires) || expires<Date.now() || !equal(signature,sign(payload,config.sessionSecret))){reply.code(401).send({error:'Session expired'});return;}
  if(!['GET','HEAD','OPTIONS'].includes(request.method)){const csrf=request.headers['x-csrf-token']; if(typeof csrf!=='string'||!equal(csrf,sign(cookie,config.sessionSecret))){reply.code(403).send({error:'CSRF token required'});return;}}
}

export async function changePassword(current:string,next:string):Promise<boolean>{const config=await appStore.read();if(!await argon2.verify(config.adminPasswordHash,current))return false;if(next.length<12)throw new Error('New password must contain at least 12 characters');await appStore.write({...config,adminPasswordHash:await argon2.hash(next)});await rm(resolve(dataDir,'config/first-run-admin.txt'),{force:true});return true;}
export async function verifyAdminPassword(password:string):Promise<boolean>{return argon2.verify((await appStore.read()).adminPasswordHash,password);}
