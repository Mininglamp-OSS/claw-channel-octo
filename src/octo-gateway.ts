import { EventEmitter } from 'node:events';
import { request } from 'undici';
import type { ConnectionState, PluginAccount, InboundMessage, ContentItem } from './index.js';
import { OCTO_CHANNEL_TYPE, OCTO_MESSAGE_TYPE } from './octo-types.js';

interface Logger { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; }

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

const MAX_CONSECUTIVE_POLL_FAILURES = 10;
const RECONNECT_BACKOFF_MAX_MS = 60_000;
const DEDUP_TTL_MS = 5 * 60 * 1000;

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
  private account: PluginAccount | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId = 0;
  private stopped = false;
  private consecutivePollFailures = 0;
  private reconnectAttempt = 0;
  private seenMessageIds = new Map<string, number>();

  constructor(
    private logger: Logger,
    private onAccountResolved?: (account: PluginAccount) => void,
  ) { super(); }

  getConnectionState(): ConnectionState { return this.state; }

  async start(account: PluginAccount): Promise<void> {
    // Notify listeners (e.g. outbound credential injection) before connecting
    this.onAccountResolved?.(account);
    const botToken = typeof account.credential.botToken === 'string' ? account.credential.botToken : '';
    const apiUrl = typeof account.credential.apiUrl === 'string' ? account.credential.apiUrl : '';
    if (!botToken || !apiUrl) {
      throw new Error('[OctoGateway] credential.botToken and credential.apiUrl must be non-empty strings');
    }
    this.botToken = botToken;
    this.apiUrl = apiUrl;
    this.account = account;
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
      this.consecutivePollFailures = 0;
      this.reconnectAttempt = 0;
      this.startPolling();
      this.startHeartbeat();
      this.startDedupCleanup();

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
    this.clearTimers();
    this.seenMessageIds.clear();
    this.state = { status: 'disconnected' };
    this.logger.info('[OctoGateway] Stopped');
  }

  private clearTimers(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.dedupCleanupTimer) { clearInterval(this.dedupCleanupTimer); this.dedupCleanupTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
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
        const events: OctoRawMessage[] = Array.isArray(data) ? data : (data as { events?: OctoRawMessage[] }).events ?? [];

        // Reset failure counter on any successful poll
        this.consecutivePollFailures = 0;

        for (const event of events) {
          if (event.event_id && event.event_id > this.lastEventId) {
            this.lastEventId = event.event_id;
          }
          const msg = event.message;
          if (!msg) continue;

          const messageId = String(msg.message_id);
          if (this.seenMessageIds.has(messageId)) {
            // Duplicate — skip silently, but still ack
          } else {
            this.seenMessageIds.set(messageId, Date.now());
            const inbound = this.buildInbound(msg);
            this.emit('inbound', inbound);
          }

          // Ack event
          try {
            const ackRes = await request(`${this.apiUrl}/v1/bot/events/${event.event_id}/ack`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${this.botToken}` },
            });
            await ackRes.body.dump();
          } catch { /* best-effort */ }
        }
      } catch (err) {
        this.consecutivePollFailures += 1;
        this.logger.warn(
          `[OctoGateway] Poll error (${this.consecutivePollFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}):`,
          err instanceof Error ? err.message : err,
        );
        if (this.consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          this.handlePollFailureThreshold();
        }
      }
    }, intervalMs);
  }

  private handlePollFailureThreshold(): void {
    const errMsg = `Poll failed ${MAX_CONSECUTIVE_POLL_FAILURES} times consecutively`;
    this.logger.error(`[OctoGateway] ${errMsg}, transitioning to error state and scheduling reconnect`);
    this.state = { status: 'error', error: errMsg };
    this.clearTimers();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempt), RECONNECT_BACKOFF_MAX_MS);
    this.reconnectAttempt += 1;
    this.logger.info(`[OctoGateway] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped || !this.account) return;
      try {
        await this.start(this.account);
      } catch {
        // start() already logged; schedule another attempt
        this.scheduleReconnect();
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        const res = await request(`${this.apiUrl}/v1/bot/heartbeat`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
          body: '{}',
        });
        await res.body.dump();
      } catch { /* best-effort */ }
    }, 30_000);
  }

  private startDedupCleanup(): void {
    this.dedupCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - DEDUP_TTL_MS;
      for (const [id, ts] of this.seenMessageIds) {
        if (ts < cutoff) this.seenMessageIds.delete(id);
      }
    }, 60_000);
  }

  private buildInbound(msg: OctoRawMessage['message']): InboundMessage {
    const channelType = msg.channel_type ?? (msg.channel_id ? OCTO_CHANNEL_TYPE.GROUP : OCTO_CHANNEL_TYPE.DM);
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
      case OCTO_MESSAGE_TYPE.TEXT: return [{ type: 'text', text: payload.content ?? '' }];
      case OCTO_MESSAGE_TYPE.IMAGE: return [{ type: 'image', url: payload.url }];
      case OCTO_MESSAGE_TYPE.FILE: return [{ type: 'file', url: payload.url, name: payload.name, size: payload.size }];
      default: return [{ type: 'text', text: payload.content ?? `[type=${payload.type}]` }];
    }
  }
}
