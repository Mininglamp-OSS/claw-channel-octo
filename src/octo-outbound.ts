import { request } from 'undici';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
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

const REQUEST_OPTS = { headersTimeout: 10_000, bodyTimeout: 30_000 } as const;

/** Simple MIME detection by extension. */
function mimeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav', '.zip': 'application/zip', '.json': 'application/json',
    '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * OctoOutbound handles sending replies from WorkBuddy Agent back to Octo.
 *
 * Capabilities:
 * - Text / image / file message sending
 * - File upload (local path → Octo storage URL, uses FormData for safe multipart)
 * - Streaming replies via message edit pattern (send → edit → edit → final)
 * - Typing indicator
 */
export class OctoOutbound {
  private apiUrl = '';
  private botToken = '';
  /** Tracks thinking message IDs per chat for ack→final edit flow. */
  private thinkingStreams = new Map<string, string>();

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

    try {
      // --- Handle deliveryMode="ack" — send thinking placeholder ---
      if (message.deliveryMode === 'ack') {
        const msgId = await this.sendMessage(chatId, channelType, { type: 1, content: '…' });
        if (msgId) {
          this.thinkingStreams.set(chatId, msgId);
        }
        return { success: true };
      }

      // --- Handle exec_approval metadata — send immediately regardless of mode ---
      if (message.metadata?.state?.startsWith('exec_approval')) {
        if (text) await this.sendMessage(chatId, channelType, { type: 1, content: text });
        return { success: true };
      }

      // --- Handle deliveryMode="streaming" — typing indicator ---
      if (message.deliveryMode === 'streaming') {
        await this.sendTyping(chatId, channelType);
        return { success: true };
      }

      // --- Handle deliveryMode="final" or default — send actual content ---
      if (!text && (!message.files || message.files.length === 0) && (!message.artifactFiles || message.artifactFiles.length === 0)) {
        return { success: false, error: 'No text or files to send' };
      }

      // Resolve all files (files + artifactFiles) atomically
      const allRawFiles = [...(message.files ?? []), ...(message.artifactFiles ?? [])];
      const resolvedFiles: Array<{ url: string; name: string }> = [];
      for (const file of allRawFiles) {
        if (file.url) {
          resolvedFiles.push({ url: file.url, name: file.name });
        } else if (file.path) {
          const uploaded = await this.uploadFile(file.path);
          resolvedFiles.push({ url: uploaded.url, name: file.name || uploaded.name });
        } else {
          return { success: false, error: `File "${file.name}" has neither url nor path` };
        }
      }

      // If we have a thinking stream for this chat, edit it with final text
      let messageId: string | undefined;
      const thinkingMsgId = this.thinkingStreams.get(chatId);
      if (thinkingMsgId && text) {
        await this.editMessage(thinkingMsgId, chatId, channelType, text);
        this.thinkingStreams.delete(chatId);
        messageId = thinkingMsgId;
      } else if (text) {
        messageId = await this.sendMessage(chatId, channelType, { type: 1, content: text });
        this.thinkingStreams.delete(chatId); // clear stale if any
      }

      // Send files
      for (const file of resolvedFiles) {
        await this.sendMessage(chatId, channelType, { type: 8, url: file.url, name: file.name });
      }

      this.logger.info(`[OctoOutbound] Sent to ${chatId} (type=${channelType}), text=${text.length}, files=${resolvedFiles.length}`);
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
   * Filename is sanitized to prevent multipart header injection.
   */
  async uploadBuffer(buffer: Buffer, filename: string): Promise<UploadResult> {
    if (!this.apiUrl || !this.botToken) {
      throw new Error('Outbound not configured — call configure() first');
    }

    const mimeType = mimeFromFilename(filename);
    // Sanitize filename: remove control chars, quotes, backslashes
    const safeName = filename.replace(/[\x00-\x1f\x7f"\\]/g, '_');
    const boundary = `----OctoUpload${Date.now()}${Math.random().toString(36).slice(2)}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
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
      ...REQUEST_OPTS,
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
   * Edit an already-sent message. Used for streaming pattern.
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
      ...REQUEST_OPTS,
    });
    if (res.statusCode >= 400) {
      const data = await res.body.text();
      throw new Error(`editMessage failed (${res.statusCode}): ${data}`);
    }
    await res.body.dump();
  }

  /**
   * Send a streaming text message: initial send followed by progressive edits.
   *
   * Note: Each `update()` call re-sends the full accumulated text via editMessage.
   * This is O(n²) for long generation streams. For callers that buffer their own
   * text, use `replace()` instead of `update()` to avoid double-buffering.
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
      ...REQUEST_OPTS,
    });
    if (res.statusCode >= 400) {
      const data = await res.body.text();
      throw new Error(`sendMessage failed (${res.statusCode}): ${data}`);
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
        ...REQUEST_OPTS,
      });
      await res.body.dump();
    } catch { /* best-effort */ }
  }
}

/**
 * Represents a message being streamed (progressively edited).
 * State is only committed after a successful edit.
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

  /** Append text and push an edit. Reverts local state on failure. */
  async update(additionalText: string): Promise<void> {
    if (this.finished) throw new Error('StreamingMessage already finished');
    const prev = this.text;
    this.text += additionalText;
    try {
      await this.outbound.editMessage(this.messageId, this.channelId, this.channelType, this.text);
    } catch (err) {
      this.text = prev;
      throw err;
    }
  }

  /** Replace full text and push an edit. Reverts on failure. */
  async replace(fullText: string): Promise<void> {
    if (this.finished) throw new Error('StreamingMessage already finished');
    const prev = this.text;
    this.text = fullText;
    try {
      await this.outbound.editMessage(this.messageId, this.channelId, this.channelType, this.text);
    } catch (err) {
      this.text = prev;
      throw err;
    }
  }

  /** Mark streaming complete with final text. State committed only after successful edit. */
  async finish(finalText?: string): Promise<void> {
    if (this.finished) return;
    const prevText = this.text;
    if (finalText !== undefined) this.text = finalText;
    try {
      await this.outbound.editMessage(this.messageId, this.channelId, this.channelType, this.text);
      this.finished = true;
    } catch (err) {
      this.text = prevText;
      throw err;
    }
  }

  getText(): string { return this.text; }
  isFinished(): boolean { return this.finished; }
}
