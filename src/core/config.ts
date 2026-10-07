import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { JsonStore } from './store.js';
import { SecretBox } from './crypto.js';

export const appSchema = z.object({ port: z.number().int().min(1).max(65535).default(3000), publicBaseUrl: z.string().default(''), logLevel: z.enum(['fatal','error','warn','info','debug','trace']).default('info'), retentionDays: z.number().int().positive().default(30), adminUsername: z.string().default('admin'), adminPasswordHash: z.string().default(''), sessionSecret: z.string().default(''), maxMediaBytes: z.number().int().positive().default(20_000_000), dedupTtlHours: z.number().int().positive().default(72) });
export const channelTypes = ['line','facebook','instagram','tiktok','youtube','whatsapp','x','telegram','wechat','pantip','generic'] as const;
export const channelSchema = z.object({ id: z.string().min(1), type: z.enum(channelTypes), name: z.string().min(1), enabled: z.boolean().default(false), integrationId: z.string().default(''), credentials: z.record(z.string(), z.string()).default({}), options: z.record(z.string(), z.unknown()).default({}), maxRetries: z.number().int().min(0).max(20).default(5), rateLimitRps: z.number().positive().default(5) });
export const genesysSchema = z.object({ id: z.string().min(1), name: z.string().min(1), region: z.string().min(1), clientId: z.string().min(1), clientSecret: z.string().min(1), integrationId: z.uuid(), webhookSecret: z.string().default(''), verifySignature: z.boolean().default(true) });
export type AppConfig = z.infer<typeof appSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type GenesysConfig = z.infer<typeof genesysSchema>;

export const dataDir = resolve(process.env.APP_DATA_DIR ?? resolve(process.cwd(), 'data'));
export const appStore = new JsonStore(resolve(dataDir, 'config/app.json'), appSchema, appSchema.parse({}));
export const channelStore = new JsonStore(resolve(dataDir, 'config/channels.json'), z.array(channelSchema), []);
export const genesysStore = new JsonStore(resolve(dataDir, 'config/genesys.json'), z.array(genesysSchema), []);

/** Loads or creates the local encryption key without printing its value. */
export async function loadSecretBox(): Promise<SecretBox> {
  let key = process.env.APP_ENCRYPTION_KEY;
  if (!key) {
    const path = resolve(process.cwd(), '.env');
    try {
      const contents = await readFile(path, 'utf8');
      key = /^APP_ENCRYPTION_KEY=(.+)$/m.exec(contents)?.[1];
      if (!key) throw new Error(`.env exists without APP_ENCRYPTION_KEY; set a base64-encoded 32-byte key in ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      key = randomBytes(32).toString('base64');
      await writeFile(path, `APP_ENCRYPTION_KEY=${key}\n`, { flag: 'wx', mode: 0o600 });
    }
  }
  return new SecretBox(key);
}

export async function loadPreviousSecretBox():Promise<SecretBox|undefined>{let key=process.env.APP_ENCRYPTION_KEY_PREVIOUS;try{const contents=await readFile(resolve(process.cwd(),'.env'),'utf8');key??=/^APP_ENCRYPTION_KEY_PREVIOUS=(.+)$/m.exec(contents)?.[1];}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}return key?new SecretBox(key):undefined;}

export async function initializeConfig(): Promise<AppConfig> {
  await mkdir(resolve(dataDir, 'config'), { recursive: true });
  const app = await appStore.read();
  await appStore.write(app);
  await channelStore.write(await channelStore.read());
  await genesysStore.write(await genesysStore.read());
  return app;
}
