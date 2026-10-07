import { resolve } from 'node:path';
import { z } from 'zod';
import { dataDir } from './config.js';
import { ConfigSecrets } from './secrets.js';
import { JsonStore } from './store.js';
import { Router } from './router.js';
import { YouTubeAdapter } from '../adapters/youtube/index.js';
import { XAdapter } from '../adapters/x/index.js';
import { TikTokAdapter } from '../adapters/tiktok/index.js';
import { recordBackgroundError } from './background-log.js';

const cursorStore=new JsonStore(resolve(dataDir,'sessions/poll-cursors.json'),z.record(z.string(),z.object({pageToken:z.string().optional(),nextPoll:z.number().default(0),backoff:z.number().default(0)})),{});
export class PollingService {
  private timer?:NodeJS.Timeout;private busy=false;
  constructor(private readonly config:ConfigSecrets,private readonly router:Router){}
  start():void{this.timer=setInterval(()=>{void this.tick();},15_000);void this.tick();}
  stop():void{if(this.timer)clearInterval(this.timer);}
  private async tick():Promise<void>{if(this.busy)return;this.busy=true;try{const channels=(await this.config.channels()).filter(x=>x.enabled&&(x.type==='youtube'||x.type==='x'||(x.type==='tiktok'&&x.credentials.commentsPollUrl)));const cursors=await cursorStore.read();for(const channel of channels){const state=cursors[channel.id]??{nextPoll:0,backoff:0};if(state.nextPoll>Date.now())continue;try{const page=channel.type==='youtube'?await new YouTubeAdapter().poll(channel,state.pageToken):channel.type==='x'?await new XAdapter().poll(channel,state.pageToken):await new TikTokAdapter().poll(channel,state.pageToken);for(const event of page.events)await this.router.inbound(channel,event);const seconds=typeof channel.options.pollIntervalSeconds==='number'?Math.max(60,channel.options.pollIntervalSeconds):60;cursors[channel.id]={pageToken:page.nextPageToken,nextPoll:Date.now()+(page.nextPageToken?15_000:seconds*1000),backoff:0};}catch(error){const backoff=Math.min(3_600_000,Math.max(60_000,(state.backoff||30_000)*2));cursors[channel.id]={...state,nextPoll:Date.now()+backoff,backoff};await recordBackgroundError(`Polling ${channel.id}`,error);}await cursorStore.write(cursors);}}finally{this.busy=false;}}
}
