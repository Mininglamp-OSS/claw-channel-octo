import { request } from 'undici';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { OutboundMessage, SendResult } from './index.js';

interface Logger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

/** Result from file upload endpoint. */
export interface UploadResult {
  url: string;
  name: string;
  size: number;
}

/** Result from sendMessage (includes message_id for streaming edits). */
interface SendMessageResult {
  message_id?: string;
}

/**
 * OctoOutbound handles sending replies from WorkBuddy Agent back to Octo.
 * Called by ClawPluginHost.sendOutbound("octo", message).
 *
 * Capabilities:
 * - Text / image / file message sending
 * - File upload (local path → Octo storage URL)
 * - Streaming replies via message edit pattern (send → edit → edit → final)
 * - Typing indicator
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
    if (!this.apiUrl || !this.botToken) {
      return { success: false, error: 'Outbound not configured — call configure() first' };
    }

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

      let messageId: string | undefined;
      if (text) {
        messageId = await this.sendMessage(chatId, channelType, { type: 1, content: text });
      }

      if (message.files) {
        for (const file of message.files) {
          // If file has a local path but no URL, upload first
          const fileUrl = file.url || (file.path ? (await this.uploadFile(file.path)).url : '');
          if (!fileUrl) continue;
          await this.sendMessage(chatId, channelType, { type: 8, url: fileUrl, name: file.name });
        }
      }

      this.logger.info(`[OctoOutbound] Sent reply to ${chatId} (type=${channelType}), textLen=${text.length}`);
      return { success: true, messageId };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OctoOutbound] Send failed:`, errMsg);
      return { success: false, error: errMsg };
    }
  }

  // ---- File Upload ----

  /**
   * Upload a local file to Octo storage.
   * @param filePath Absolute path to the file
   * @returns Upload result with the hosted URL
   */
  async uploadFile(filePath: string): Promise<UploadResult> {
    if (!this.apiUrl || !this.botToken) {
      throw new Error('Outbound not configured — call configure() first');
    }
    const fileBuffer = await readFile(filePath);
    const fileName = basename(filePath);
    return this.uploadBuffer(fileBuffer, fileName);
  }

  /**
   * Upload a buffer to Octo storage.
   * @param buffer File content as Buffer
   * @param filename Name for the uploaded file
   * @returns Upload result with the hosted URL
   */
  async uploadBuffer(buffer: Buffer, filename: string): Promise<UploadResult> {
    if (!this.apiUrl || !this.botToken) {
      throw new Error('Outbound not configured — call configure() first');
    }

    // Build multipart/form-data manually using a boundary
    const boundary = `----OctoUpload${Date.now()}${Math.random().toString(36).slice(2)}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    const res = await request(`${this.apiUrl}/v1/bot/file/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.byteLength),
      },
      body,
    });

    if (res.statusCode >= 400) {
      const data = await res.body.text();
      throw new Error(`File upload failed (${res.statusCode}): ${data}`);
    }

    const result = await res.body.json() as UploadResult;
    this.logger.info(`[OctoOutbound] Uploaded file: ${filename} → ${result.url}`);
    return result;
  }

  // ---- Streaming (Message Edit) ----

  /**
   * Edit an already-sent message. Used for streaming pattern:
   * send initial partial text → progressively edit with more content → final edit.
   *
   * @param messageId The message_id returned from the initial send
   * @param channelId Target channel
   * @param channelType Target channel type
   * @param text Updated full text content
   */
  async editMessage(messageId: string, channelId: string, channelType: number, text: string): Promise<void> {
    if (!this.apiUrl || !this.botToken) {
      throw new Error('Outbound not configured');
    }
    const res = await request(`${this.apiUrl}/v1/bot/message/edit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_id: messageId,
        channel_id: channelId,
        channel_type: channelType,
        payload: { type: 1, content: text },
      }),
    });
    if (res.statusCode >= 400) {
      const data = await res.body.text();
      throw new Error(`editMessage failed (${res.statusCode}): ${data}`);
    }
    await res.body.dump();
  }

  /**
   * Send a streaming text message: initial send followed by progressive edits.
   * Returns an object with an `update()` method for appending text and `finish()`
   * for the final edit.
   */
  async startStreaming(channelId: string, channelType: number, initialText: string): Promise<StreamingMessage> {
    const messageId = await this.sendMessage(channelId, channelType, { type: 1, content: initialText });
    if (!messageId) {
      throw new Error('Failed to get message_id from initial send — streaming not supported');
    }
    return new StreamingMessage(this, messageId, channelId, channelType, initialText);
  }

  // ---- Private ----

  private async sendMessage(channelId: string, channelType: number, payload: Record<string, unknown>): Promise<string | undefined> {
    const res = await request(`${this.apiUrl}/v1/bot/sendMessage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, channel_type: channelType, payload }),
    });
    if (res.statusCode >= 400) {
      const data = await res.body.json();
      throw new Error(`sendMessage failed (${res.statusCode}): ${JSON.stringify(data)}`);
    }
    const result = await res.body.json() as SendMessageResult;
    return result.message_id;
  }

  private async sendTyping(channelId: string, channelType: number): Promise<void> {
    try {
      const res = await request(`${this.apiUrl}/v1/bot/typing`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId, channel_type: channelType }),
      });
      await res.body.dump();
    } catch { /* best-effort */ }
  }
}

/**
 * Represents a message being streamed (progressively edited).
 * Created by OctoOutbound.startStreaming().
 */
export class StreamingMessage {
  private text: string;
  private finished = false;

  constructor(
    private outbound: OctoOutbound,
    readonly messageId: string,
    private channelId: string,
    private channelType: number,
    initialText: string,
  ) {
    this.text = initialText;
  }

  /** Append text and push an edit. */
  async update(additionalText: string): Promise<void> {
    if (this.finished) throw new Error('StreamingMessage already finished');
    this.text += additionalText;
    await this.outbound.editMessage(this.messageId, this.channelId, this.channelType, this.text);
  }

  /** Replace full text and push an edit. */
  async replace(fullText: string): Promise<void> {
    if (this.finished) throw new Error('StreamingMessage already finished');
    this.text = fullText;
    await this.outbound.editMessage(this.messageId, this.channelId, this.channelType, this.text);
  }

  /** Mark streaming complete with final text. */
  async finish(finalText?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (finalText !== undefined) this.text = finalText;
    await this.outbound.editMessage(this.messageId, this.channelId, this.channelType, this.text);
  }

  getText(): string { return this.text; }
  isFinished(): boolean { return this.finished; }
}
