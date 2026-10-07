import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from './config.js';
import { recordBackgroundError } from './background-log.js';

export type QueueItem<T> = { id: string; payload: T; attempts: number; maxRetries: number; nextAt: number; createdAt: string };
export type DeadLetter<T> = QueueItem<T> & {error:string};
type JournalEntry<T> = { op: 'put'; item: QueueItem<T> } | { op: 'done'|'dead'; id: string };

/** One-process durable FIFO with a replayable JSONL journal and dead letters. */
export class DurableQueue<T> {
  private readonly journal = resolve(dataDir, 'queue/outbound-current.jsonl');
  private readonly dead = resolve(dataDir, 'dlq/outbound-current.jsonl');
  private readonly items = new Map<string, QueueItem<T>>();
  private timer?: NodeJS.Timeout;
  private working = false;
  constructor(private readonly deliver: (payload: T) => Promise<void>, private readonly onFailure?: (item: QueueItem<T>, error: Error) => Promise<void>) {}
  static backoff(attempt: number, jitter = Math.random()): number { return Math.min(300_000, 1000 * 2 ** Math.min(attempt, 8)) + Math.floor(jitter * 1000); }
  async start(): Promise<void> {
    await mkdir(resolve(dataDir, 'queue'), { recursive: true }); await mkdir(resolve(dataDir, 'dlq'), { recursive: true });
    let body = ''; try { body = await readFile(this.journal, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const line of body.split('\n').filter(Boolean)) { const entry = JSON.parse(line) as JournalEntry<T>; if (entry.op === 'put') this.items.set(entry.item.id, entry.item); else this.items.delete(entry.id); }
    await writeFile(this.journal, [...this.items.values()].map(item => JSON.stringify({ op: 'put', item })).join('\n') + (this.items.size ? '\n' : ''));
    this.timer = setInterval(() => { void this.tick().catch(error=>recordBackgroundError('Queue tick failed',error)); }, 250);
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); while (this.working) await new Promise(resolve => setTimeout(resolve, 20)); }
  list(): QueueItem<T>[] { return [...this.items.values()]; }
  async enqueue(payload: T, maxRetries = 5): Promise<string> { const item = { id: randomUUID(), payload, attempts: 0, maxRetries, nextAt: Date.now(), createdAt: new Date().toISOString() }; await this.record({ op: 'put', item }); this.items.set(item.id, item); return item.id; }
  async retry(id: string): Promise<boolean> { const item = this.items.get(id); if (!item) return false; item.nextAt = Date.now(); item.attempts = 0; await this.record({ op: 'put', item }); return true; }
  async retryAll():Promise<number>{let count=0;for(const id of this.items.keys())if(await this.retry(id))count++;return count;}
  async purge():Promise<number>{const ids=[...this.items.keys()];for(const id of ids){await this.record({op:'done',id});this.items.delete(id);}return ids.length;}
  async deadLetters():Promise<DeadLetter<T>[]>{try{return (await readFile(this.dead,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line) as DeadLetter<T>);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}}
  async retryDead(id:string):Promise<boolean>{const all=await this.deadLetters();const found=all.find(x=>x.id===id);if(!found)return false;await this.enqueue(found.payload,found.maxRetries);await this.writeDead(all.filter(x=>x.id!==id));return true;}
  async purgeDead():Promise<number>{const all=await this.deadLetters();await this.writeDead([]);return all.length;}
  private async writeDead(items:DeadLetter<T>[]):Promise<void>{const temporary=`${this.dead}.${randomUUID()}.tmp`;await writeFile(temporary,items.map(x=>JSON.stringify(x)).join('\n')+(items.length?'\n':''));await rename(temporary,this.dead);}
  private async record(entry: JournalEntry<T>): Promise<void> { await appendFile(this.journal, `${JSON.stringify(entry)}\n`); }
  private async tick(): Promise<void> {
    if (this.working) return; const item = [...this.items.values()].find(x => x.nextAt <= Date.now()); if (!item) return;
    this.working = true;
    try { await this.deliver(item.payload); await this.record({ op: 'done', id: item.id }); this.items.delete(item.id); }
    catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause)); item.attempts++;
      if (this.onFailure) await this.onFailure(item, error).catch(callbackError=>recordBackgroundError('Queue failure callback failed',callbackError));
      if (item.attempts > item.maxRetries) { await appendFile(this.dead, `${JSON.stringify({ ...item, error: error.message })}\n`); await this.record({ op: 'dead', id: item.id }); this.items.delete(item.id); }
      else { item.nextAt = Date.now() + DurableQueue.backoff(item.attempts); await this.record({ op: 'put', item }); }
    } finally { this.working = false; }
  }
}
