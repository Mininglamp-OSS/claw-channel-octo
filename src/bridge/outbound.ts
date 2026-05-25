import type { OctoRestApi } from '../octo/rest-api.js';
import { agpToOctoPayload } from '../octo/message-codec.js';
import { parseReplyTarget } from './session-map.js';
import type {
  AGPMessage,
  SessionUpdatePayload,
  SessionPromptResponsePayload,
  ContentBlock,
} from '../centrifuge/agp-types.js';

/**
 * Outbound bridge: Centrifuge publications → Octo replies.
 *
 * Listens for AGP session.update and session.promptResponse messages
 * from WorkBuddy and forwards them back to the correct Octo channel.
 */
export class OutboundBridge {
  /** Track which chatIds have received a typing indicator to avoid spam */
  private readonly typingSent = new Set<string>();

  constructor(
    private readonly octoApi: OctoRestApi,
    private readonly logger = console,
  ) {}

  /**
   * Handle a Centrifuge publication. Called for every message published
   * to the subscribed channel.
   */
  async handlePublication(data: unknown): Promise<void> {
    const msg = data as AGPMessage;
    if (!msg?.method) {
      this.logger.warn('[OutboundBridge] Received publication without method, ignoring');
      return;
    }

    switch (msg.method) {
      case 'session.update':
        await this.handleSessionUpdate(msg.payload as unknown as SessionUpdatePayload);
        break;

      case 'session.promptResponse':
        await this.handlePromptResponse(msg.payload as unknown as SessionPromptResponsePayload);
        break;

      default:
        this.logger.info(`[OutboundBridge] Ignoring method: ${msg.method}`);
        break;
    }
  }

  /**
   * Handle session.update — send typing indicator to Octo.
   * Only sends once per chatId to avoid spamming.
   */
  private async handleSessionUpdate(payload: SessionUpdatePayload): Promise<void> {
    const chatId = (payload as unknown as Record<string, unknown>).chatId as string | undefined;
    if (!chatId) return;

    // Only send typing once per chatId per session
    if (this.typingSent.has(chatId)) return;
    this.typingSent.add(chatId);

    const target = parseReplyTarget(chatId);
    if (!target) {
      this.logger.warn(`[OutboundBridge] Cannot parse reply target from chatId: ${chatId}`);
      return;
    }

    try {
      await this.octoApi.typing(target.channelId, target.channelType);
      this.logger.info(`[OutboundBridge] Sent typing to ${target.channelId} (type=${target.channelType})`);
    } catch (err) {
      this.logger.warn('[OutboundBridge] Failed to send typing indicator:', err);
    }
  }

  /**
   * Handle session.promptResponse — convert AGP response to Octo message and send.
   */
  private async handlePromptResponse(payload: SessionPromptResponsePayload): Promise<void> {
    const chatId = (payload as unknown as Record<string, unknown>).chatId as string | undefined;
    if (!chatId) {
      this.logger.warn('[OutboundBridge] promptResponse missing chatId, cannot route reply');
      return;
    }

    // Clear typing state for this chatId
    this.typingSent.delete(chatId);

    const target = parseReplyTarget(chatId);
    if (!target) {
      this.logger.warn(`[OutboundBridge] Cannot parse reply target from chatId: ${chatId}`);
      return;
    }

    // Convert AGP content to Octo payload
    const content = payload.content as ContentBlock[] | undefined;
    if (!content || content.length === 0) {
      this.logger.warn('[OutboundBridge] promptResponse has no content');
      return;
    }

    const octoPayload = agpToOctoPayload(content);
    if (!octoPayload.content) {
      this.logger.warn('[OutboundBridge] Converted payload has no text content');
      return;
    }

    try {
      await this.octoApi.sendMessage(target.channelId, target.channelType, {
        type: octoPayload.type,
        content: octoPayload.content ?? '',
      });
      this.logger.info(
        `[OutboundBridge] Sent reply to ${target.channelId} (type=${target.channelType}), len=${octoPayload.content.length}`,
      );
    } catch (err) {
      this.logger.error('[OutboundBridge] Failed to send reply to Octo:', err);
      throw err;
    }
  }
}
