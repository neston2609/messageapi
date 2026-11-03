import { channelStore, genesysStore, type ChannelConfig, type GenesysConfig } from './config.js';
import { SecretBox } from './crypto.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export class ConfigSecrets {
  constructor(private box: SecretBox,private previous?:SecretBox) {}
  private decode(value: string): string { if(!value.startsWith('enc:v1:'))return value;try{return this.box.decrypt(value);}catch(error){if(this.previous)return this.previous.decrypt(value);throw error;} }
  private encode(value: string): string { return value.startsWith('enc:v1:') ? value : this.box.encrypt(value); }
  async channels(): Promise<ChannelConfig[]> { return (await channelStore.read()).map(c => ({ ...c, credentials: Object.fromEntries(Object.entries(c.credentials).map(([k,v]) => [k,this.decode(v)])) })); }
  async genesys(): Promise<GenesysConfig[]> { return (await genesysStore.read()).map(c => ({ ...c, clientSecret: this.decode(c.clientSecret), webhookSecret: c.webhookSecret ? this.decode(c.webhookSecret) : '' })); }
  async saveChannel(value: ChannelConfig): Promise<void> { const all = await channelStore.read(); const previous = all.find(c => c.id === value.id); const credentials={...(previous?.credentials??{})};for(const [k,v] of Object.entries(value.credentials))credentials[k]=(v===''||v.startsWith('••••'))&&previous?.credentials[k]?previous.credentials[k]:this.encode(v);if(value.type==='youtube'&&value.options.youtubeAuthMode==='apiKey'){for(const key of ['oauthClientId','oauthClientSecret','refreshToken','accessToken'])delete credentials[key];}else if(value.type==='youtube'&&value.options.youtubeAuthMode==='oauth')delete credentials.apiKey;const next = { ...value, credentials }; await channelStore.write([...all.filter(c => c.id !== value.id), next]); }
  async saveGenesys(value: GenesysConfig): Promise<void> { const all = await genesysStore.read(); const previous = all.find(c => c.id === value.id); const next = { ...value, clientSecret: !value.clientSecret || value.clientSecret.startsWith('••••') ? previous?.clientSecret || '' : value.clientSecret, webhookSecret: !value.webhookSecret || value.webhookSecret.startsWith('••••') ? previous?.webhookSecret || '' : value.webhookSecret }; if (!next.clientSecret) throw new Error('Genesys client secret is required'); await genesysStore.write([...all.filter(c => c.id !== value.id), { ...next, clientSecret: this.encode(next.clientSecret), webhookSecret: next.webhookSecret ? this.encode(next.webhookSecret) : '' }]); }
  reEncrypt(value:string,source?:SecretBox):string{if(!value)return '';const plaintext=value.startsWith('enc:v1:')?(source?source.decrypt(value):this.decode(value)):value;return this.box.encrypt(plaintext);}
  static mask(value: string): string { return value ? `••••${value.slice(-4)}` : ''; }
  validateCiphertext(value:string):void{this.decode(value);}
  /** Rotates credentials with a dual-key recovery window across file writes. */
  async rotateKey():Promise<void>{
    if(this.previous)throw new Error('Finish the previous key rotation before starting another');
    const path=resolve(process.cwd(),'.env');const contents=await readFile(path,'utf8');const oldKey=/^APP_ENCRYPTION_KEY=(.+)$/m.exec(contents)?.[1];if(!oldKey||process.env.APP_ENCRYPTION_KEY)throw new Error('Key rotation requires the app-managed .env key');
    const channels=await this.channels();const integrations=await this.genesys();const newKey=randomBytes(32).toString('base64');const nextBox=new SecretBox(newKey);
    const dual=contents.replace(/^APP_ENCRYPTION_KEY=.*/m,`APP_ENCRYPTION_KEY=${newKey}`).replace(/^APP_ENCRYPTION_KEY_PREVIOUS=.*\r?\n?/m,'').trimEnd()+`\nAPP_ENCRYPTION_KEY_PREVIOUS=${oldKey}\n`;
    const writeEnv=async(body:string)=>{const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,body,{mode:0o600});await rename(temp,path);};
    await writeEnv(dual);this.previous=this.box;this.box=nextBox;
    await channelStore.write(channels.map(c=>({...c,credentials:Object.fromEntries(Object.entries(c.credentials).map(([k,v])=>[k,this.encode(v)]))})));
    await genesysStore.write(integrations.map(g=>({...g,clientSecret:this.encode(g.clientSecret),webhookSecret:g.webhookSecret?this.encode(g.webhookSecret):''})));
    await writeEnv(dual.replace(/^APP_ENCRYPTION_KEY_PREVIOUS=.*\r?\n?/m,''));this.previous=undefined;
  }
  async finalizeRotation():Promise<void>{if(!this.previous)return;const channels=await this.channels();const integrations=await this.genesys();await channelStore.write(channels.map(c=>({...c,credentials:Object.fromEntries(Object.entries(c.credentials).map(([k,v])=>[k,this.encode(v)]))})));await genesysStore.write(integrations.map(g=>({...g,clientSecret:this.encode(g.clientSecret),webhookSecret:g.webhookSecret?this.encode(g.webhookSecret):''})));const path=resolve(process.cwd(),'.env');const contents=await readFile(path,'utf8');const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,contents.replace(/^APP_ENCRYPTION_KEY_PREVIOUS=.*\r?\n?/m,''),{mode:0o600});await rename(temp,path);this.previous=undefined;}
}
