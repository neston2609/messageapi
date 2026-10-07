import { resolve } from 'node:path';
import { z } from 'zod';
import { dataDir } from './config.js';
import { JsonStore } from './store.js';

const schema = z.record(z.string(), z.number());
export class DedupStore {
  private readonly store = new JsonStore(resolve(dataDir, 'sessions/dedup.json'), schema, {});
  private readonly cache=new Map<string,number>();private loaded=false;
  private async load():Promise<void>{if(this.loaded)return;for(const [id,expiry] of Object.entries(await this.store.read()))if(expiry>Date.now())this.cache.set(id,expiry);this.loaded=true;}
  async has(id: string): Promise<boolean> {await this.load();const expiry=this.cache.get(id);if(!expiry||expiry<=Date.now()){this.cache.delete(id);return false;}this.cache.delete(id);this.cache.set(id,expiry);return true;}
  async add(id: string, ttlMs: number): Promise<void> {await this.load();const now=Date.now();for(const [key,expiry] of this.cache)if(expiry<=now)this.cache.delete(key);this.cache.delete(id);this.cache.set(id,now+ttlMs);while(this.cache.size>50_000)this.cache.delete(this.cache.keys().next().value!);await this.store.write(Object.fromEntries(this.cache));}
}
