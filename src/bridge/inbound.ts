import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { OctoInboundMessage } from '../octo/ws-client.js';
import { octoPayloadToText } from '../octo/message-codec.js';
import { MessageDedup } from './session-map.js';

/**
 * Inbound bridge: Octo message → MCP `notifications/claude/channel`.
 *
 * The MCP server is connected to WorkBuddy via stdio; emitting a notification
 * is how the AI is woken up with the inbound chat message.
 */
export class InboundBridge {
  private readonly dedup = new MessageDedup();

  constructor(
    private readonly mcp: Server,
    private readonly allowedSenders: Set<string>,
    private readonly logger = console,
  ) {}

  async handleOctoMessage(msg: OctoInboundMessage): Promise<void> {
    if (this.allowedSenders.size > 0 && !this.allowedSenders.has(msg.from_uid)) {
      this.logger.info(`[InboundBridge] Dropping message from non-allowed sender: ${msg.from_uid}`);
      return;
    }

    if (this.dedup.isDuplicate(msg.message_id)) {
      this.logger.info(`[InboundBridge] Dropping duplicate message: ${msg.message_id}`);
      return;
    }

    const content = octoPayloadToText(msg.payload) || `[type=${msg.payload.type}]`;
    const chatId = msg.channel_id ?? msg.from_uid;
    const chatType = String(msg.channel_type ?? 1);

    this.logger.info(
      `[InboundBridge] notify channel: chat_id=${chatId} chat_type=${chatType} from=${msg.from_uid} msgId=${msg.message_id}`,
    );

    await this.mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          source: 'octo',
          sender: msg.from_uid,
          sender_name: msg.sender_name ?? msg.from_uid,
          chat_id: chatId,
          chat_type: chatType,
          message_id: String(msg.message_id),
        },
      },
    });
  }

  dispose(): void {
    this.dedup.dispose();
  }
}
