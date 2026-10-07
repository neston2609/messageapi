import { Writable } from 'node:stream';
import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Rotates JSON logs on date and size, keeping one current file per day. */
export class RotatingFileStream extends Writable {
  private size=0;private day='';
  constructor(private readonly directory:string,private readonly maxBytes=10_000_000){super();}
  override _write(chunk:Buffer|string,_encoding:BufferEncoding,callback:(error?:Error|null)=>void):void{void this.append(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)).then(()=>callback(),error=>callback(error as Error));}
  private async append(bytes:Buffer):Promise<void>{await mkdir(this.directory,{recursive:true});const day=new Date().toISOString().slice(0,10);const file=resolve(this.directory,`${day}.log`);if(this.day!==day){this.day=day;try{this.size=(await stat(file)).size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;this.size=0;}}if(this.size+bytes.length>this.maxBytes){try{await rename(file,resolve(this.directory,`${day}-${randomUUID()}.log`));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}this.size=0;}await appendFile(file,bytes);this.size+=bytes.length;}
  async prune(retentionDays:number):Promise<void>{const cutoff=Date.now()-retentionDays*24*60*60_000;for(const name of await readdir(this.directory)){if(!name.endsWith('.log'))continue;const file=resolve(this.directory,name);if((await stat(file)).mtimeMs<cutoff)await rm(file,{force:true});}}
}
