import { resolve } from 'node:path';
import { z } from 'zod';
import { dataDir } from './config.js';
import { JsonStore } from './store.js';

const sessionSchema = z.object({ channelId: z.string(), userId: z.string(), conversationId: z.string().default(''), lastActivity: z.string(), replyToken:z.string().optional(), replyTokenExpiresAt:z.number().optional() });
export type Session = z.infer<typeof sessionSchema>;
export const sessionStore = new JsonStore(resolve(dataDir, 'sessions/sessions.json'), z.array(sessionSchema), []);

export async function touchSession(channelId: string, userId: string, conversationId = '', replyToken?:string): Promise<void> {
  const all = await sessionStore.read();
  const existing = all.find(s => s.channelId === channelId && s.userId === userId);
  await sessionStore.write([...all.filter(s => s !== existing), { channelId, userId, conversationId: conversationId || existing?.conversationId || '', lastActivity: new Date().toISOString(),replyToken:replyToken??existing?.replyToken,replyTokenExpiresAt:replyToken?Date.now()+60_000:existing?.replyTokenExpiresAt }]);
}
