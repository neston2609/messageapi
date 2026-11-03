import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('HTTP integration',()=>{
  it('requires admin auth and CSRF, verifies webhooks, and deduplicates inbound',async()=>{
    const root=await mkdtemp(join(tmpdir(),'bridge-http-'));vi.stubEnv('APP_DATA_DIR',root);vi.stubEnv('APP_ENCRYPTION_KEY',randomBytes(32).toString('base64'));vi.stubEnv('NODE_ENV','test');
    const {createApp}=await import('../src/server.js');const {ConfigSecrets}=await import('../src/core/secrets.js');const {SecretBox}=await import('../src/core/crypto.js');
    const {app}=await createApp();
    try{
      expect((await app.inject('/api/admin/channels')).statusCode).toBe(401);
      const password=(await readFile(join(root,'config/first-run-admin.txt'),'utf8')).match(/^Password: (.+)$/m)?.[1];expect(password).toBeTruthy();
      const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin',password}});expect(login.statusCode).toBe(200);
      const setCookie=login.headers['set-cookie'];const cookie=(Array.isArray(setCookie)?setCookie[0]:setCookie)?.split(';')[0]??'';const csrf=login.json<{csrf:string}>().csrf;
      expect((await app.inject({method:'PUT',url:'/api/admin/settings',headers:{cookie},payload:{publicBaseUrl:'https://example.com'}})).statusCode).toBe(403);
      expect((await app.inject({method:'PUT',url:'/api/admin/settings',headers:{cookie,'x-csrf-token':csrf},payload:{publicBaseUrl:'https://example.com'}})).statusCode).toBe(200);
      const secrets=new ConfigSecrets(new SecretBox(process.env.APP_ENCRYPTION_KEY!));
      await secrets.saveGenesys({id:'g1',name:'G',region:'mypurecloud.com',clientId:'id',clientSecret:'client-secret',integrationId:'a4fac3cc-c30c-47cd-a065-293897e2d508',webhookSecret:'hook-secret',verifySignature:true});
      await secrets.saveChannel({id:'c1',type:'generic',name:'C',enabled:true,integrationId:'g1',credentials:{webhookSecret:'channel-secret',outboundUrl:'https://example.com/send',outboundToken:'token'},options:{},maxRetries:1,rateLimitRps:10});
      const exported=await app.inject({method:'GET',url:'/api/admin/export',headers:{cookie}});expect(exported.statusCode).toBe(200);
      const backup=exported.json<{format:string;version:number;channels:Array<Record<string,unknown>>;genesys:Array<Record<string,unknown>>}>();expect(backup).toMatchObject({format:'messageapi-configuration',version:2});expect(backup.channels).toHaveLength(1);expect(backup.genesys).toHaveLength(1);
      const broken={...backup,channels:backup.channels.map(channel=>({...channel,integrationId:'missing'}))};
      expect((await app.inject({method:'POST',url:'/api/admin/import',headers:{cookie,'x-csrf-token':csrf},payload:broken})).statusCode).toBe(400);
      const wrongKey={...backup,channels:backup.channels.map(channel=>({...channel,credentials:{webhookSecret:'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA'}})),genesys:backup.genesys.map(integration=>({...integration,clientSecret:'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA'}))};
      const rejectedImport=await app.inject({method:'POST',url:'/api/admin/import',headers:{cookie,'x-csrf-token':csrf},payload:wrongKey});
      expect(rejectedImport.statusCode).toBe(400);expect(rejectedImport.json()).toMatchObject({error:'Encrypted credentials could not be decrypted. Check the source APP_ENCRYPTION_KEY from the server that exported this file.'});
      const unchanged=await app.inject({method:'GET',url:'/api/admin/export',headers:{cookie}});expect(unchanged.json()).toMatchObject({app:{publicBaseUrl:'https://example.com'},channels:backup.channels,genesys:backup.genesys});
      const sourceKey=randomBytes(32).toString('base64');const sourceBox=new SecretBox(sourceKey);
      const foreignBackup={...backup,channels:backup.channels.map(channel=>({...channel,credentials:{webhookSecret:sourceBox.encrypt('channel-secret'),outboundUrl:sourceBox.encrypt('https://example.com/send'),outboundToken:sourceBox.encrypt('token')}})),genesys:backup.genesys.map(integration=>({...integration,clientSecret:sourceBox.encrypt('client-secret'),webhookSecret:sourceBox.encrypt('hook-secret')}))};
      const importedForeign=await app.inject({method:'POST',url:'/api/admin/import',headers:{cookie,'x-csrf-token':csrf},payload:{...foreignBackup,sourceEncryptionKey:sourceKey}});
      expect(importedForeign.statusCode).toBe(200);expect(importedForeign.json()).toMatchObject({ok:true,channels:1,genesysIntegrations:1});
      const afterForeignImport=await app.inject({method:'GET',url:'/api/admin/export',headers:{cookie}});const importedChannel=afterForeignImport.json<{channels:Array<{credentials:Record<string,string>}>}>().channels[0]!;
      expect(new SecretBox(process.env.APP_ENCRYPTION_KEY!).decrypt(importedChannel.credentials.webhookSecret!)).toBe('channel-secret');
      expect((await app.inject({method:'POST',url:'/api/admin/import',headers:{cookie,'x-csrf-token':csrf},payload:backup})).json()).toMatchObject({ok:true,channels:1,genesysIntegrations:1});
      const calls:string[]=[];vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>{calls.push(String(input));return String(input).includes('/oauth/token')?new Response(JSON.stringify({access_token:'token',expires_in:3600}),{status:200}):new Response('{}',{status:200});});
      const raw='{"id":"event-1","userId":"customer-1","text":"hello"}';const signature=`sha256=${createHmac('sha256','channel-secret').update(raw).digest('hex')}`;
      expect((await app.inject({method:'POST',url:'/webhooks/channel/c1',headers:{'content-type':'application/json','x-hub-signature-256':'sha256=bad'},payload:raw})).statusCode).toBe(401);
      const request={method:'POST' as const,url:'/webhooks/channel/c1',headers:{'content-type':'application/json','x-hub-signature-256':signature},payload:raw};
      expect((await app.inject(request)).statusCode).toBe(200);expect((await app.inject(request)).statusCode).toBe(200);
      expect(calls.filter(x=>x.includes('/inbound/open/message'))).toHaveLength(1);
      const outbound=JSON.stringify({id:'agent-message-1',channel:{messageId:'agent-message-1',to:{id:'generic:c1:customer-1'}},type:'Text',text:'agent reply'});
      const outboundSignature=`sha256=${createHmac('sha256','hook-secret').update(outbound).digest('hex')}`;
      expect((await app.inject({method:'POST',url:'/webhooks/genesys/a4fac3cc-c30c-47cd-a065-293897e2d508',headers:{'content-type':'application/json','x-hub-signature-256':outboundSignature},payload:outbound})).statusCode).toBe(200);
      const nonMessage=JSON.stringify({type:'Event',channel:{to:{id:'a4fac3cc-c30c-47cd-a065-293897e2d508'}}});const nonMessageSignature=`sha256=${createHmac('sha256','hook-secret').update(nonMessage).digest('hex')}`;
      expect((await app.inject({method:'POST',url:'/webhooks/genesys/a4fac3cc-c30c-47cd-a065-293897e2d508',headers:{'content-type':'application/json','x-hub-signature-256':nonMessageSignature},payload:nonMessage})).json()).toMatchObject({accepted:false,ignored:true});
      for(let index=0;index<20&&!calls.some(x=>x.includes('/inbound/open/receipt'));index++)await new Promise(resolve=>setTimeout(resolve,100));
      expect(calls.some(x=>x==='https://example.com/send')).toBe(true);
      expect(calls.some(x=>x.includes('/inbound/open/receipt'))).toBe(true);
    }finally{await app.close();vi.unstubAllGlobals();vi.unstubAllEnvs();}
  },15_000);
});
