/**
 * Octo Claw Plugin — built-in WorkBuddy channel for Octo IM.
 * Aligned with ClawPluginHost contract (callback-based gateway, capabilities, streaming).
 */
import { OctoGateway } from './octo-gateway.js';
import { OctoOutbound } from './octo-outbound.js';
import { OctoConfigResolver } from './octo-config.js';

export interface PluginContext {
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  hostConfig?: Record<string, unknown>;
}

export interface ConnectionState {
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  error?: string;
}

export interface PluginAccount {
  accountId: string;
  credential: Record<string, unknown>;
  platformMeta?: Record<string, unknown>;
}

export interface InboundMessage {
  messageId: string;
  content: ContentItem[];
  sender: { senderId: string; senderName: string };
  timestamp: string;
  /** Group info — present for group/thread messages. */
  group?: { groupId: string; chatType: 'group' | 'direct' };
  /** Whether the bot was @mentioned in this message. */
  botMentioned?: boolean;
  replyContext: {
    chatId: string;
    channelType: string;
    connectionMode: string;
    sessionId?: string;
    requestId?: string;
    userId?: string;
    msgType?: string;
  };
}

export interface ContentItem {
  type: 'text' | 'image' | 'file';
  text?: string;
  url?: string;
  /** Local file path (for downloaded media). */
  uri?: string;
  /** MIME type. */
  mimeType?: string;
  name?: string;
  size?: number;
}

export interface OutboundMessage {
  text?: string;
  files?: Array<{ url?: string; path?: string; name: string }>;
  /** Artifact files from Agent (same shape as files). */
  artifactFiles?: Array<{ url?: string; path?: string; name: string }>;
  deliveryMode?: 'ack' | 'streaming' | 'final';
  /** Metadata from Agent runtime (exec_approval state, etc). */
  metadata?: { state?: string; [k: string]: unknown };
  replyContext: Record<string, unknown>;
}

export interface SendResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

export interface PluginCapabilities {
  sendText: boolean;
  sendMarkdown: boolean;
  sendMedia: boolean;
  interactive: boolean;
  streaming: boolean;
  groupChat: boolean;
  threading: boolean;
}

export interface ClawPlugin {
  id: string;
  meta: { name: string; displayName: string; icon?: string; description?: string; transport: string; isDualMode: boolean };
  config: OctoConfigResolver;
  gateway: OctoGateway;
  outbound: OctoOutbound;
  capabilities: PluginCapabilities;
  defaultReplyPolicy: { mode: 'all' | 'none' | 'allowlist'; allowedSenderIds?: string[] };
}

export type PluginFactory = (ctx: PluginContext) => ClawPlugin;

export function createOctoPlugin(ctx: PluginContext): ClawPlugin {
  const logger = ctx.logger;
  const config = new OctoConfigResolver(logger);
  const outbound = new OctoOutbound(logger);
  const gateway = new OctoGateway(logger, (account) => {
    const botToken = typeof account.credential.botToken === 'string' ? account.credential.botToken : '';
    const apiUrl = typeof account.credential.apiUrl === 'string' ? account.credential.apiUrl : '';
    if (botToken && apiUrl) {
      outbound.configure(apiUrl, botToken);
    }
  });

  return {
    id: 'octo',
    meta: {
      name: 'Octo',
      displayName: 'Octo IM',
      icon: 'octo',
      description: 'Octo IM — DM, Group, and Thread messaging',
      transport: 'websocket',
      isDualMode: false,
    },
    config,
    gateway,
    outbound,
    capabilities: {
      sendText: true,
      sendMarkdown: true,
      sendMedia: true,
      interactive: false,
      streaming: true,
      groupChat: true,
      threading: true,
    },
    defaultReplyPolicy: { mode: 'all' },
  };
}

export default createOctoPlugin;
