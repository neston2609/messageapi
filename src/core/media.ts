import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appStore, dataDir } from './config.js';

type MediaMetadata={mimeType:string;expiresAt:number};
const dir=resolve(dataDir,'media');
const allowed=['image/','video/','audio/','application/pdf','text/plain','application/octet-stream'];
export class MediaStore {
  private signature(value:string,key:string):string{return createHmac('sha256',key).update(value).digest('base64url');}
  async download(url:string,headers:Record<string,string>={}):Promise<string>{
    if(!url.startsWith('https://'))throw new Error('Media source must use HTTPS');
    const config=await appStore.read();if(!config.publicBaseUrl.startsWith('https://'))throw new Error('Public HTTPS base URL is required for media');
    const response=await fetch(url,{headers,signal:AbortSignal.timeout(20_000)});if(!response.ok)throw new Error(`Media download failed: HTTP ${response.status}`);
    const mimeType=(response.headers.get('content-type')??'application/octet-stream').split(';')[0];if(!allowed.some(x=>mimeType.startsWith(x)))throw new Error(`Media type ${mimeType} is not allowed`);
    const length=Number(response.headers.get('content-length')??0);if(length>config.maxMediaBytes)throw new Error('Media exceeds configured size limit');
    if(!response.body)throw new Error('Media download returned no body');const reader=response.body.getReader();const chunks:Buffer[]=[];let total=0;while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>config.maxMediaBytes){await reader.cancel();throw new Error('Media exceeds configured size limit');}chunks.push(Buffer.from(part.value));}const bytes=Buffer.concat(chunks,total);
    await mkdir(dir,{recursive:true});const id=randomUUID();const expiresAt=Date.now()+24*60*60_000;await writeFile(resolve(dir,id),bytes,{flag:'wx'});await writeFile(resolve(dir,`${id}.json`),JSON.stringify({mimeType,expiresAt} satisfies MediaMetadata));
    const payload=`${id}.${expiresAt}`;return `${config.publicBaseUrl.replace(/\/$/,'')}/media/${payload}.${this.signature(payload,config.sessionSecret)}`;
  }
  async read(token:string):Promise<{bytes:Buffer;mimeType:string}|null>{
    const [id,expiry,signature]=token.split('.');if(!id||!expiry||!signature||!/^[0-9a-f-]{36}$/.test(id))return null;
    const config=await appStore.read();const expected=this.signature(`${id}.${expiry}`,config.sessionSecret);const a=Buffer.from(signature);const b=Buffer.from(expected);if(a.length!==b.length||!timingSafeEqual(a,b)||Number(expiry)<Date.now())return null;
    try{const metadata=JSON.parse(await readFile(resolve(dir,`${id}.json`),'utf8')) as MediaMetadata;if(metadata.expiresAt<Date.now())return null;return {bytes:await readFile(resolve(dir,id)),mimeType:metadata.mimeType};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  async cleanup():Promise<void>{await mkdir(dir,{recursive:true});for(const name of await readdir(dir)){if(!name.endsWith('.json'))continue;const path=resolve(dir,name);const metadata=JSON.parse(await readFile(path,'utf8')) as MediaMetadata;if(metadata.expiresAt<Date.now()){await rm(path,{force:true});await rm(resolve(dir,name.slice(0,-5)),{force:true});}}}
}
