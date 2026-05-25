import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

/**
 * Inbound message from Octo WebSocket.
 */
export interface OctoInboundMessage {
  from_uid: string;
  sender_name?: string;
  channel_id?: string;
  channel_type: number;
  message_id: string;
  payload: {
    type: number;
    content?: string;
    url?: string;
    name?: string;
    size?: number;
  };
}

interface OctoWsClientEvents {
  message: [msg: OctoInboundMessage];
  connected: [];
  disconnected: [reason: string];
  error: [err: Error];
}

/**
 * Octo WebSocket client using WuKongIM protocol.
 *
 * Phase 1 MVP: Uses the HTTP events polling fallback via the Bot API
 * rather than the full WuKongIM binary WebSocket protocol.
 * The binary protocol (connect frame, subscribe frame, recv frame,
 * ping/pong) requires reverse-engineering the exact frame layout.
 *
 * TODO: Implement full WuKongIM binary WebSocket protocol for lower
 * latency. For now, we poll /v1/bot/events via REST and emit messages.
 */
export class OctoWebSocketClient extends EventEmitter<OctoWsClientEvents> {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private readonly maxReconnectDelay = 30_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastEventId = 0;

  constructor(
    private readonly apiUrl: string,
    private readonly botToken: string,
    private readonly logger = console,
  ) {
    super();
  }

  /**
   * Start receiving messages via HTTP long-polling on the Bot events API.
   * This is the Phase 1 approach — simpler than the binary WS protocol.
   */
  async startPolling(pollIntervalMs = 2000): Promise<void> {
    this.stopped = false;
    this.logger.info('[OctoWsClient] Starting event polling');
    this.emit('connected');

    const poll = async () => {
      if (this.stopped) return;
      try {
        const { request } = await import('undici');
        const res = await request(`${this.apiUrl}/v1/bot/events?last_event_id=${this.lastEventId}&limit=50`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        const data = (await res.body.json()) as any;
        const events = Array.isArray(data) ? data : data?.events ?? [];
        for (const event of events) {
          if (event.event_id && event.event_id > this.lastEventId) {
            this.lastEventId = event.event_id;
          }
          const msg = event.message;
          if (!msg) continue;

          const inbound: OctoInboundMessage = {
            from_uid: msg.from_uid,
            sender_name: msg.from_uid,
            channel_id: msg.channel_id,
            channel_type: msg.channel_type ?? (msg.channel_id ? 2 : 1),
            message_id: String(msg.message_id),
            payload: msg.payload ?? { type: 1, content: '' },
          };
          this.emit('message', inbound);

          // Acknowledge the event
          try {
            await request(`${this.apiUrl}/v1/bot/events/${event.event_id}/ack`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${this.botToken}` },
            });
          } catch {
            // Best-effort ack
          }
        }
        this.reconnectAttempt = 0;
      } catch (err) {
        this.reconnectAttempt++;
        const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay);
        this.logger.warn(`[OctoWsClient] Poll error (retry in ${delay}ms):`, err);
      }
    };

    // Initial poll
    await poll();
    // Recurring poll
    this.pollTimer = setInterval(poll, pollIntervalMs);
  }

  /**
   * Connect via full WuKongIM WebSocket binary protocol.
   * TODO: Implement binary frame encoding/decoding for WuKongIM.
   * For now this is a stub that falls back to polling.
   */
  async connect(wsUrl: string, imToken: string): Promise<void> {
    this.logger.info(`[OctoWsClient] WuKongIM WS connect requested (wsUrl=${wsUrl})`);
    this.logger.info('[OctoWsClient] Full binary protocol not yet implemented, falling back to event polling');
    // TODO: Implement WuKongIM binary WebSocket protocol:
    // 1. Open WebSocket to wsUrl
    // 2. Send CONNECT frame with imToken
    // 3. Handle CONNACK
    // 4. Send SUBSCRIBE frames for channels
    // 5. Handle RECV frames → emit 'message'
    // 6. Send PING every 30s, expect PONG
    await this.startPolling();
  }

  /**
   * Disconnect and stop all timers.
   */
  disconnect(): void {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.emit('disconnected', 'manual');
  }
}
