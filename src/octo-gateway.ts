import { EventEmitter } from 'node:events';
import { request } from 'undici';
import type { ConnectionState, PluginAccount, InboundMessage, ContentItem } from './index.js';

interface Logger { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void; }

interface OctoRawMessage {
  event_id?: number;
  message: {
    message_id: string | number;
    from_uid: string;
    channel_id?: string;
    channel_type?: number;
    payload: { type: number; content?: string; url?: string; name?: string; size?: number };
    timestamp?: number;
  };
}

/**
 * OctoGateway manages the WebSocket connection to Octo (WuKongIM protocol).
 *
 * Phase 1 uses HTTP event polling as MVP. Full WuKongIM binary WebSocket
 * protocol implementation is Phase 2.
 *
 * Emits 'inbound' event with InboundMessage when a message arrives.
 */
export class OctoGateway extends EventEmitter {
  private state: ConnectionState = { status: 'disconnected' };
  private apiUrl = '';
  private botToken = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventId = 0;
  private stopped = false;

  constructor(private logger: Logger) { super(); }

  getConnectionState(): ConnectionState { return this.state; }

  async start(account: PluginAccount): Promise<void> {
    const { botToken, apiUrl } = account.credential as { botToken: string; apiUrl: string };
    this.botToken = botToken;
    this.apiUrl = apiUrl;
    this.stopped = false;
    this.state = { status: 'connecting' };

    this.logger.info('[OctoGateway] Starting with apiUrl:', apiUrl);

    try {
      // Register bot to confirm connectivity
      const regRes = await request(`${apiUrl}/v1/bot/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const regData = await regRes.body.json() as Record<string, unknown>;

      if (regRes.statusCode >= 400) {
        throw new Error(`Register failed (${regRes.statusCode}): ${JSON.stringify(regData)}`);
      }

      this.logger.info(`[OctoGateway] Bot registered: ${regData.robot_id}`);

      // TODO Phase 2: Use regData.ws_url + regData.im_token for full WuKongIM WebSocket
      // For now, use HTTP event polling
      this.startPolling();
      this.startHeartbeat();

      this.state = { status: 'connected' };
      this.logger.info('[OctoGateway] Connected (polling mode)');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state = { status: 'error', error: msg };
      this.logger.error('[OctoGateway] Start failed:', msg);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.state = { status: 'disconnected' };
    this.logger.info('[OctoGateway] Stopped');
  }

  private startPolling(intervalMs = 2000): void {
    this.pollTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        const res = await request(
          `${this.apiUrl}/v1/bot/events?last_event_id=${this.lastEventId}&limit=50`,
          { method: 'GET', headers: { Authorization: `Bearer ${this.botToken}` } },
        );
        const data = await res.body.json() as OctoRawMessage[] | { events?: OctoRawMessage[] };
        const events: OctoRawMessage[] = Array.isArray(data) ? data : (data as any).events ?? [];

        for (const event of events) {
          if (event.event_id && event.event_id > this.lastEventId) {
            this.lastEventId = event.event_id;
          }
          const msg = event.message;
          if (!msg) continue;

          const inbound = this.buildInbound(msg);
          this.emit('inbound', inbound);

          // Ack event
          try {
            await request(`${this.apiUrl}/v1/bot/events/${event.event_id}/ack`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${this.botToken}` },
            });
          } catch { /* best-effort */ }
        }
      } catch (err) {
        this.logger.warn('[OctoGateway] Poll error:', err instanceof Error ? err.message : err);
      }
    }, intervalMs);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await request(`${this.apiUrl}/v1/bot/heartbeat`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch { /* best-effort */ }
    }, 30_000);
  }

  private buildInbound(msg: OctoRawMessage['message']): InboundMessage {
    const channelType = msg.channel_type ?? (msg.channel_id ? 2 : 1);
    const chatId = msg.channel_id ?? msg.from_uid;
    const content: ContentItem[] = this.parsePayload(msg.payload);

    return {
      messageId: String(msg.message_id),
      content,
      sender: { senderId: msg.from_uid, senderName: msg.from_uid },
      timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : new Date().toISOString(),
      replyContext: {
        chatId,
        channelType: String(channelType),
        connectionMode: 'websocket',
        userId: msg.from_uid,
        msgType: String(msg.payload.type),
      },
    };
  }

  private parsePayload(payload: OctoRawMessage['message']['payload']): ContentItem[] {
    switch (payload.type) {
      case 1: return [{ type: 'text', text: payload.content ?? '' }];
      case 2: return [{ type: 'image', url: payload.url }];
      case 8: return [{ type: 'file', url: payload.url, name: payload.name, size: payload.size }];
      default: return [{ type: 'text', text: payload.content ?? `[type=${payload.type}]` }];
    }
  }
}
