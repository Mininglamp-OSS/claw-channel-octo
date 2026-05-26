/**
 * Octo Claw Plugin — built-in WorkBuddy channel for Octo IM.
 * Same architecture as WecomAiBotPlugin.
 */
import { OctoGateway } from './octo-gateway.js';
import { OctoOutbound } from './octo-outbound.js';
import { OctoConfigResolver } from './octo-config.js';

/** Context provided by ClawPluginHost when creating a plugin instance. */
export interface PluginContext {
  /** Logger instance for structured output. */
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  /** Optional host-level configuration. */
  hostConfig?: Record<string, unknown>;
}

/** Real-time connection state of the plugin gateway. */
export interface ConnectionState {
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  /** Error message when status is 'error'. */
  error?: string;
}

/** Resolved account credentials for starting the plugin. */
export interface PluginAccount {
  /** Unique identifier for this account instance. */
  accountId: string;
  /** Credential fields (botToken, apiUrl, etc.). */
  credential: Record<string, unknown>;
  /** Platform-specific metadata (e.g. connectionMode). */
  platformMeta?: Record<string, unknown>;
}

/** Message received from Octo, passed to ClawPluginHost.emitInbound(). */
export interface InboundMessage {
  /** Unique message identifier. */
  messageId: string;
  /** Message content blocks (text, image, file). */
  content: ContentItem[];
  /** Sender information. */
  sender: { senderId: string; senderName: string };
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Context for routing replies back to the correct chat. */
  replyContext: {
    /** Target chat identifier (UID for DM, group_no for group, group____thread for thread). */
    chatId: string;
    /** Channel type as string: "1"=DM, "2"=Group, "5"=Thread. */
    channelType: string;
    /** Always "websocket" for Octo — replies go via plugin outbound. */
    connectionMode: string;
    sessionId?: string;
    requestId?: string;
    /** Original sender UID. */
    userId?: string;
    /** Payload type as string (e.g. "1" for text). */
    msgType?: string;
  };
}

/** A single content block within a message. */
export interface ContentItem {
  type: 'text' | 'image' | 'file';
  /** Text content (for type='text'). */
  text?: string;
  /** URL of media/file (for type='image'|'file'). */
  url?: string;
  /** File name (for type='file'). */
  name?: string;
  /** File size in bytes (for type='file'). */
  size?: number;
}

/** Message to send back to Octo, received from ClawPluginHost.sendOutbound(). */
export interface OutboundMessage {
  /** Text content to send. */
  text?: string;
  /** Files to send (uploaded URLs or local paths). */
  files?: Array<{ url?: string; path?: string; name: string }>;
  /** 'streaming' sends typing indicator only; 'final' sends the actual message. */
  deliveryMode?: 'streaming' | 'final';
  /** Reply routing context from the original inbound message. */
  replyContext: Record<string, unknown>;
}

/** Result of an outbound send operation. */
export interface SendResult {
  success: boolean;
  /** Error description when success is false. */
  error?: string;
  /** Message ID returned on successful send (used for streaming edits). */
  messageId?: string;
}

/** Complete plugin interface registered with ClawPluginHost. */
export interface ClawPlugin {
  /** Channel type identifier (e.g. "octo"). */
  id: string;
  /** Display metadata for the Claw settings UI. */
  meta: { name: string; icon?: string; description?: string };
  /** Account configuration resolver. */
  config: OctoConfigResolver;
  /** Gateway managing the IM connection lifecycle. */
  gateway: OctoGateway;
  /** Outbound adapter for sending replies. */
  outbound: OctoOutbound;
  /** Declared capabilities of this channel. */
  capabilities?: { supportedMessageTypes?: string[]; supportsStreaming?: boolean; supportsFileUpload?: boolean };
}

/** Factory function signature for creating a ClawPlugin. */
export type PluginFactory = (ctx: PluginContext) => ClawPlugin;

/**
 * Factory function to create the Octo plugin.
 * Called by ClawPluginHost.registerPlugin().
 */
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
      icon: 'octo',
      description: 'Octo IM — DM, Group, and Thread messaging',
    },
    config,
    gateway,
    outbound,
    capabilities: {
      supportedMessageTypes: ['text', 'image', 'file'],
      supportsStreaming: true,
      supportsFileUpload: true,
    },
  };
}

export default createOctoPlugin;
