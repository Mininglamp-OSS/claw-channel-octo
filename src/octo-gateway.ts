import { EventEmitter } from 'node:events';
import { request } from 'undici';
import type { ConnectionState, PluginAccount, InboundMessage, ContentItem } from './index.js';
import { OCTO_CHANNEL_TYPE, OCTO_MESSAGE_TYPE } from './octo-types.js';
import { OctoWebSocket, type OctoWsMessage } from './octo-websocket.js';

interface Logger { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; }

const DEDUP_TTL_MS = 5 * 60 * 1000;
const REQUEST_OPTS = { headersTimeout: 10_000, bodyTimeout: 30_000 } as const;

/**
 * OctoGateway manages the real-time WebSocket connection to Octo.
 *
 * Transport: JSON-RPC over WebSocket. No fallback — if the WebSocket
 * connection fails, the gateway throws so the caller knows something
 * is wrong (bad config, service down) instead of silently degrading.
 *
 * REST heartbeat is kept separately for bot online status tracking.
 *
 * Emits 'inbound' event with InboundMessage when a message arrives.
 */
export class OctoGateway extends EventEmitter {
  private state: ConnectionState = { status: 'disconnected' };
  private apiUrl = '';
  private botToken = '';
  private account: PluginAccount | null = null;
  private ws: OctoWebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private seenMessageIds = new Map<string, number>();

  constructor(
    private logger: Logger,
    private onAccountResolved?: (account: PluginAccount) => void,
  ) { super(); }

  getConnectionState(): ConnectionState { return this.state; }

  async start(account: PluginAccount): Promise<void> {
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
      // Register bot — check status FIRST, parse JSON only on success
      const regRes = await request(`${apiUrl}/v1/bot/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
        body: '{}',
        ...REQUEST_OPTS,
      });

      if (regRes.statusCode >= 400) {
        const errBody = await regRes.body.text();
        throw new Error(`Register failed (${regRes.statusCode}): ${errBody}`);
      }

      const regData = await regRes.body.json() as Record<string, unknown>;
      const wsUrl = typeof regData.ws_url === 'string' ? regData.ws_url : '';
      const imToken = typeof regData.im_token === 'string' ? regData.im_token : '';
      const robotId = typeof regData.robot_id === 'string' ? regData.robot_id : '';

      if (!wsUrl || !imToken || !robotId) {
        throw new Error('Register response missing ws_url, im_token, or robot_id — cannot connect');
      }

      this.logger.info(`[OctoGateway] Bot registered: ${robotId}`);

      // Connect WebSocket — assign before connect so catch can clean up
      const ws = new OctoWebSocket(this.logger);
      this.ws = ws;
      ws.on('message', (msg: OctoWsMessage) => this.handleMessage(msg));
      ws.on('connect', () => {
        if (!this.stopped) this.state = { status: 'connected' };
      });
      ws.on('disconnect', () => {
        if (!this.stopped) this.state = { status: 'connecting' };
      });
      ws.on('fatal', (err: Error) => {
        this.state = { status: 'error', error: err.message };
        this.logger.error('[OctoGateway] WebSocket fatal:', err.message);
      });

      await ws.connect(wsUrl, robotId, imToken);

      // Heartbeat + dedup cleanup
      this.startHeartbeat();
      this.startDedupCleanup();

      this.state = { status: 'connected' };
      this.logger.info('[OctoGateway] Connected (websocket)');
    } catch (err) {
      // Clean up any partially-connected WebSocket
      if (this.ws) {
        try { this.ws.removeAllListeners(); this.ws.disconnect(); } catch { /* ignore */ }
        this.ws = null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.state = { status: 'error', error: msg };
      this.logger.error('[OctoGateway] Start failed:', msg);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.dedupCleanupTimer) { clearInterval(this.dedupCleanupTimer); this.dedupCleanupTimer = null; }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.disconnect(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.seenMessageIds.clear();
    this.state = { status: 'disconnected' };
    this.logger.info('[OctoGateway] Stopped');
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        const res = await request(`${this.apiUrl}/v1/bot/heartbeat`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
          body: '{}',
          ...REQUEST_OPTS,
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

  private handleMessage(msg: OctoWsMessage): void {
    const messageId = String(msg.messageId);
    if (this.seenMessageIds.has(messageId)) return;
    this.seenMessageIds.set(messageId, Date.now());

    const channelType = msg.channelType || (msg.channelId ? OCTO_CHANNEL_TYPE.GROUP : OCTO_CHANNEL_TYPE.DM);
    const chatId = msg.channelId || msg.fromUid;
    const content: ContentItem[] = this.parsePayload(msg.payload);

    const inbound: InboundMessage = {
      messageId,
      content,
      sender: { senderId: msg.fromUid, senderName: msg.fromUid },
      timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : new Date().toISOString(),
      replyContext: {
        chatId,
        channelType: String(channelType),
        connectionMode: 'websocket',
        userId: msg.fromUid,
        msgType: String(msg.payload.type),
      },
    };
    this.emit('inbound', inbound);
  }

  private parsePayload(payload: OctoWsMessage['payload']): ContentItem[] {
    switch (payload.type) {
      case OCTO_MESSAGE_TYPE.TEXT:
        return [{ type: 'text', text: payload.content ?? '' }];
      case OCTO_MESSAGE_TYPE.IMAGE:
      case 3: // GIF
        return [{ type: 'image', url: payload.url }];
      case 4: // Voice
        return [{ type: 'file', url: payload.url, name: 'voice' }];
      case 5: // Video
        return [{ type: 'file', url: payload.url, name: payload.name ?? 'video' }];
      case OCTO_MESSAGE_TYPE.FILE:
        return [{ type: 'file', url: payload.url, name: payload.name, size: payload.size }];
      default:
        this.logger.warn(`[OctoGateway] Unknown payload type ${payload.type}, treating as text`);
        return [{ type: 'text', text: payload.content ?? `[unsupported type=${payload.type}]` }];
    }
  }
}
