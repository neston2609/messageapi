import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { dataDir } from './config.js';

export type MessageRecord={time:string;channelId:string;direction:'inbound'|'outbound';status:string;messageId:string;raw:unknown;normalized:unknown;error?:string};
const path=resolve(dataDir,'logs/messages.jsonl');
export async function recordMessage(record:MessageRecord):Promise<void>{await mkdir(resolve(dataDir,'logs'),{recursive:true});await appendFile(path,`${JSON.stringify(record)}\n`);}
export async function listMessages(limit=200):Promise<MessageRecord[]>{let body='';try{body=await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}return body.trim().split('\n').filter(Boolean).slice(-limit).reverse().map(line=>JSON.parse(line) as MessageRecord);}
export async function pruneMessages(retentionDays:number):Promise<void>{let body='';try{body=await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}const cutoff=Date.now()-retentionDays*24*60*60_000;const kept=body.split('\n').filter(Boolean).filter(line=>{const record=JSON.parse(line) as MessageRecord;return new Date(record.time).getTime()>=cutoff;});const temporary=`${path}.${randomUUID()}.tmp`;await writeFile(temporary,kept.join('\n')+(kept.length?'\n':''));await rename(temporary,path);}
