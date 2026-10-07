import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataDir } from './config.js';

const logDir=resolve(dataDir,'logs');
const logPath=resolve(logDir,'background-errors.log');

/** Records worker failures without writing into an undrained service pipe. */
export async function recordBackgroundError(scope:string,error:unknown):Promise<void>{
  const message=error instanceof Error?error.message:String(error);
  try{await mkdir(logDir,{recursive:true});await appendFile(logPath,`${new Date().toISOString()} ${scope}: ${message.replace(/[\r\n]+/g,' ')}\n`,'utf8');}catch{/* Logging must never stop a background worker. */}
}
