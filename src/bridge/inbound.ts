import { randomUUID } from 'node:crypto';
import type { CentrifugeClient } from '../centrifuge/client.js';
import type { OctoInboundMessage } from '../octo/ws-client.js';
import { octoToAgp } from '../octo/message-codec.js';
import {
  generateSessionId,
  encodeChatId,
  generateRequestId,
  MessageDedup,
} from './session-map.js';
import type { AGPMessage, SessionPromptPayload } from '../centrifuge/agp-types.js';

/**
 * Inbound bridge: Octo messages → AGP session.prompt → Centrifuge publish.
 */
export class InboundBridge {
  private readonly dedup = new MessageDedup();

  constructor(
    private readonly centrifuge: CentrifugeClient,
    private readonly channel: string,
    private readonly allowedSenders: Set<string>,
    private readonly logger = console,
  ) {}

  /**
   * Handle an inbound Octo message.
   * Checks allowlist, deduplicates, converts to AGP, and publishes to Centrifuge.
   */
  async handleOctoMessage(msg: OctoInboundMessage): Promise<void> {
    // Sender allowlist check (empty set = allow all)
    if (this.allowedSenders.size > 0 && !this.allowedSenders.has(msg.from_uid)) {
      this.logger.info(`[InboundBridge] Dropping message from non-allowed sender: ${msg.from_uid}`);
      return;
    }

    // Dedup check
    if (this.dedup.isDuplicate(msg.message_id)) {
      this.logger.info(`[InboundBridge] Dropping duplicate message: ${msg.message_id}`);
      return;
    }

    // Convert Octo payload to AGP content blocks
    const content = octoToAgp(msg.payload);
    if (content.length === 0) {
      this.logger.warn(`[InboundBridge] Empty content after conversion, skipping msgId=${msg.message_id}`);
      return;
    }

    // Build AGP session.prompt
    const sessionId = generateSessionId(msg.channel_type, msg.channel_id, msg.from_uid);
    const chatId = encodeChatId(msg.channel_type, msg.channel_id, msg.from_uid);
    const requestId = generateRequestId(msg.message_id);

    const agpPayload: SessionPromptPayload = {
      content,
      sessionId,
      requestId,
      channelType: 'octo',
      chatId,
      user: msg.from_uid,
      timestamp: new Date().toISOString(),
    };

    const agpMessage: AGPMessage = {
      msg_id: randomUUID(),
      method: 'session.prompt',
      payload: agpPayload as unknown as Record<string, unknown>,
    };

    this.logger.info(
      `[InboundBridge] Publishing session.prompt: sessionId=${sessionId} chatId=${chatId} from=${msg.from_uid} reqId=${requestId}`,
    );

    try {
      await this.centrifuge.publish(this.channel, agpMessage);
    } catch (err) {
      this.logger.error(`[InboundBridge] Failed to publish to Centrifuge:`, err);
      throw err;
    }
  }

  dispose(): void {
    this.dedup.dispose();
  }
}
