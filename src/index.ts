/**
 * Octo Claw Plugin — built-in WorkBuddy channel for Octo IM.
 * Same architecture as WecomAiBotPlugin.
 */
import { OctoGateway } from './octo-gateway.js';
import { OctoOutbound } from './octo-outbound.js';
import { OctoConfigResolver } from './octo-config.js';

export interface PluginContext {
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
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
  name?: string;
  size?: number;
}

export interface OutboundMessage {
  text?: string;
  files?: Array<{ url: string; name: string }>;
  deliveryMode?: 'streaming' | 'final';
  replyContext: Record<string, unknown>;
}

export interface SendResult {
  success: boolean;
  error?: string;
}

export interface ClawPlugin {
  id: string;
  meta: { name: string; icon?: string; description?: string };
  config: OctoConfigResolver;
  gateway: OctoGateway;
  outbound: OctoOutbound;
  capabilities?: { supportedMessageTypes?: string[]; supportsStreaming?: boolean };
}

export type PluginFactory = (ctx: PluginContext) => ClawPlugin;

/**
 * Factory function to create the Octo plugin.
 * Called by ClawPluginHost.registerPlugin().
 */
export function createOctoPlugin(ctx: PluginContext): ClawPlugin {
  const logger = ctx.logger;
  const config = new OctoConfigResolver(logger);
  const gateway = new OctoGateway(logger);
  const outbound = new OctoOutbound(logger);

  return {
    id: 'octo',
    meta: {
      name: 'Octo',
      icon: 'octo',
      description: 'Octo IM — DM, Group, and Thread messaging',
    },
    config,
    gateway,
    outbound,
    capabilities: {
      supportedMessageTypes: ['text', 'image', 'file'],
      supportsStreaming: true,
    },
  };
}

export default createOctoPlugin;
