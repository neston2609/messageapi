import type { ChannelConfig } from './config.js';

export type ChannelType = ChannelConfig['type'];
export type Attachment = { type: 'Image'|'Video'|'Audio'|'File'; url: string; mimeType?: string; name?: string };
export type InboundEvent = { id: string; userId: string; time: string; text?: string; attachments?: Attachment[]; kind?: 'message'|'typing'|'read'; conversationId?: string; replyToken?:string; profile?: { firstName?: string; lastName?: string; nickname?: string; image?: string } };
export type OutboundEvent = { id: string; userId: string; text?: string; attachments?: Attachment[]; quickReplies?: string[]; cards?: Array<{ title: string; description?: string; url?: string }>; kind?: 'message'|'typing'|'read'; replyToId?: string; replyToken?:string; template?:{name:string;language:string} };
export type RawRequest = { headers: Record<string, string | string[] | undefined>; rawBody: Buffer; body: unknown; query?: Record<string,string> };
export type ChallengeResponse = { status: number; body: string };
export type SendResult = { id?: string; delivered: boolean; error?: string };
export type UserProfile = { firstName?: string; lastName?: string; nickname?: string; image?: string };
export type HealthStatus = { ok: boolean; detail: string };
export type Capabilities = { text: boolean; image: boolean; video: boolean; audio: boolean; file: boolean; quickReply: boolean; card: boolean; carousel: boolean; typing: boolean; readReceipt: boolean; maxTextLength: number; sessionWindowHours: number | null };

/** Channel boundary. Each registered channel adapter implements the same contract. */
export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly capabilities: Capabilities;
  verifyWebhook(req: RawRequest, cfg: ChannelConfig): Promise<boolean>;
  handleChallenge?(req: RawRequest, cfg: ChannelConfig): ChallengeResponse | null;
  parseInbound(req: RawRequest, cfg: ChannelConfig): Promise<InboundEvent[]>;
  sendOutbound(msg: OutboundEvent, cfg: ChannelConfig): Promise<SendResult>;
  fetchUserProfile?(userId: string, cfg: ChannelConfig): Promise<UserProfile>;
  healthCheck(cfg: ChannelConfig): Promise<HealthStatus>;
}
