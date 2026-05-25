import { request } from 'undici';
import type { OutboundMessage, SendResult } from './index.js';

interface Logger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

/**
 * OctoOutbound handles sending replies from WorkBuddy Agent back to Octo.
 * Called by ClawPluginHost.sendOutbound("octo", message).
 */
export class OctoOutbound {
  private apiUrl = '';
  private botToken = '';

  constructor(private logger: Logger) {}

  /** Called when plugin starts, to inject credentials. */
  configure(apiUrl: string, botToken: string): void {
    this.apiUrl = apiUrl;
    this.botToken = botToken;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const chatId = String(message.replyContext.chatId ?? '');
    const channelType = Number(message.replyContext.channelType ?? 1);
    const text = message.text ?? '';

    if (!chatId) {
      return { success: false, error: 'Missing chatId in replyContext' };
    }
    if (!text && (!message.files || message.files.length === 0)) {
      return { success: false, error: 'No text or files to send' };
    }

    try {
      if (message.deliveryMode === 'streaming') {
        await this.sendTyping(chatId, channelType);
        return { success: true };
      }

      if (text) {
        await this.sendMessage(chatId, channelType, { type: 1, content: text });
      }

      if (message.files) {
        for (const file of message.files) {
          await this.sendMessage(chatId, channelType, { type: 8, url: file.url, name: file.name });
        }
      }

      this.logger.info(`[OctoOutbound] Sent reply to ${chatId} (type=${channelType}), textLen=${text.length}`);
      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OctoOutbound] Send failed:`, errMsg);
      return { success: false, error: errMsg };
    }
  }

  private async sendMessage(channelId: string, channelType: number, payload: Record<string, unknown>): Promise<void> {
    const res = await request(`${this.apiUrl}/v1/bot/sendMessage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, channel_type: channelType, payload }),
    });
    if (res.statusCode >= 400) {
      const data = await res.body.json();
      throw new Error(`sendMessage failed (${res.statusCode}): ${JSON.stringify(data)}`);
    }
    await res.body.dump();
  }

  private async sendTyping(channelId: string, channelType: number): Promise<void> {
    try {
      await request(`${this.apiUrl}/v1/bot/typing`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId, channel_type: channelType }),
      });
    } catch { /* best-effort */ }
  }
}
