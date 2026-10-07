import type { ChannelAdapter, ChannelType } from '../core/types.js';
import { LineAdapter } from './line/index.js';
import { MetaAdapter } from './meta/index.js';
import { GenericAdapter } from './generic/index.js';
import { TelegramAdapter } from './telegram/index.js';
import { WhatsAppAdapter } from './whatsapp/index.js';
import { YouTubeAdapter } from './youtube/index.js';
import { WeChatAdapter } from './wechat/index.js';
import { XAdapter } from './x/index.js';
import { TikTokAdapter } from './tiktok/index.js';
import { PantipAdapter } from './pantip/index.js';

const adapters: Partial<Record<ChannelType, ChannelAdapter>> = { line:new LineAdapter(), facebook:new MetaAdapter('facebook'), instagram:new MetaAdapter('instagram'), whatsapp:new WhatsAppAdapter(), telegram:new TelegramAdapter(), youtube:new YouTubeAdapter(), x:new XAdapter(), wechat:new WeChatAdapter(), tiktok:new TikTokAdapter(), pantip:new PantipAdapter(), generic:new GenericAdapter() };
export function getAdapter(type: ChannelType): ChannelAdapter { const adapter=adapters[type]; if (!adapter) throw new Error(`${type} adapter is not implemented yet`); return adapter; }
export function adapterCapabilities() { return Object.fromEntries(Object.entries(adapters).map(([type,adapter]) => [type,adapter.capabilities])); }
