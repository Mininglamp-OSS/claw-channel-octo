import { request } from 'undici';
import type { ConnectionState, PluginAccount, InboundMessage, ContentItem } from './index.js';
import { OCTO_CHANNEL_TYPE, OCTO_MESSAGE_TYPE, isThreadChannelId, parseThreadChannelId } from './octo-types.js';
import { OctoWebSocket, type OctoWsMessage } from './octo-websocket.js';

interface Logger { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; }

const DEDUP_TTL_MS = 5 * 60 * 1000;
const REQUEST_OPTS = { headersTimeout: 10_000, bodyTimeout: 30_000 } as const;

/**
 * OctoGateway — WebSocket connection to Octo.
 *
 * ClawPluginHost injects callbacks:
 *   gateway.onInboundMessage = (msg) => ...
 *   gateway.onConnectionStateChange = (state) => ...
 *
 * Does NOT extend EventEmitter — uses callback properties per ClawPluginHost contract.
 */
export class OctoGateway {
  /** ClawPluginHost injects this to receive messages. */
  onInboundMessage: ((msg: InboundMessage) => void) | null = null;
  /** ClawPluginHost injects this to track connection state. */
  onConnectionStateChange: ((state: ConnectionState) => void) | null = null;

  private state: ConnectionState = { status: 'disconnected' };
  private apiUrl = '';
  private botToken = '';
  private botUid = '';
  private botName = '';
  private account: PluginAccount | null = null;
  private ws: OctoWebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private seenMessageIds = new Map<string, number>();

  constructor(
    private logger: Logger,
    private onAccountResolved?: (account: PluginAccount) => void,
  ) {}

  getConnectionState(): ConnectionState { return this.state; }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.onConnectionStateChange?.(s);
  }

  async startAccount(account: PluginAccount): Promise<void> {
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
    this.setState({ status: 'connecting' });

    this.logger.info('[OctoGateway] Starting with apiUrl:', apiUrl);

    try {
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
        throw new Error('Register response missing ws_url, im_token, or robot_id');
      }

      this.botUid = robotId;
      this.botName = typeof regData.name === 'string' ? regData.name : '';
      this.logger.info(`[OctoGateway] Bot registered: ${robotId}`);

      const ws = new OctoWebSocket(this.logger);
      this.ws = ws;
      ws.on('message', (msg: OctoWsMessage) => this.handleMessage(msg));
      ws.on('connect', () => { if (!this.stopped) this.setState({ status: 'connected' }); });
      ws.on('disconnect', () => { if (!this.stopped) this.setState({ status: 'connecting' }); });
      ws.on('fatal', (err: Error) => {
        this.logger.error('[OctoGateway] WebSocket fatal:', err.message);
        this.setState({ status: 'error', error: err.message });
      });

      await ws.connect(wsUrl, robotId, imToken);

      this.startHeartbeat();
      this.startDedupCleanup();
      this.setState({ status: 'connected' });
      this.logger.info('[OctoGateway] Connected (websocket)');
    } catch (err) {
      if (this.ws) {
        try { this.ws.removeAllListeners(); this.ws.disconnect(); } catch { /* ignore */ }
        this.ws = null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ status: 'error', error: msg });
      this.logger.error('[OctoGateway] Start failed:', msg);
      throw err;
    }
  }

  async stopAccount(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.dedupCleanupTimer) { clearInterval(this.dedupCleanupTimer); this.dedupCleanupTimer = null; }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.disconnect(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.seenMessageIds.clear();
    this.setState({ status: 'disconnected' });
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

    // Determine group info
    const isGroup = channelType === OCTO_CHANNEL_TYPE.GROUP || channelType === 5;
    let group: InboundMessage['group'];
    if (isGroup) {
      // For threads, extract parent group ID
      const groupId = (channelType === 5 && isThreadChannelId(chatId))
        ? parseThreadChannelId(chatId)!.groupNo
        : chatId;
      const chatType = channelType === 5 ? 'thread' as const : 'group' as const;
      group = { groupId, chatType };
    }

    // Detect @bot mention — check Octo rich text format @[uid:name] and plain @name
    const textContent = msg.payload.content ?? '';
    let botMentioned: boolean | undefined;
    if (isGroup) {
      botMentioned = textContent.includes(`@[${this.botUid}:`)
        || (this.botName !== '' && textContent.includes(`@${this.botName}`))
        || textContent.includes('@所有人');
    }

    const inbound: InboundMessage = {
      messageId,
      content,
      sender: { senderId: msg.fromUid, senderName: msg.fromUid },
      timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : new Date().toISOString(),
      group,
      botMentioned,
      replyContext: {
        chatId,
        channelType: String(channelType),
        connectionMode: 'websocket',
        userId: msg.fromUid,
        msgType: String(msg.payload.type),
      },
    };
    this.onInboundMessage?.(inbound);
  }

  private parsePayload(payload: OctoWsMessage['payload']): ContentItem[] {
    switch (payload.type) {
      case OCTO_MESSAGE_TYPE.TEXT:
        return [{ type: 'text', text: payload.content ?? '' }];
      case OCTO_MESSAGE_TYPE.IMAGE:
      case 3: // GIF
        return [{ type: 'image', url: payload.url, mimeType: payload.type === 3 ? 'image/gif' : undefined }];
      case 4: // Voice
        return [{ type: 'file', url: payload.url, name: 'voice', mimeType: 'audio/mpeg' }];
      case 5: // Video
        return [{ type: 'file', url: payload.url, name: payload.name ?? 'video', mimeType: 'video/mp4' }];
      case OCTO_MESSAGE_TYPE.FILE:
        return [{ type: 'file', url: payload.url, name: payload.name, size: payload.size }];
      default:
        this.logger.warn(`[OctoGateway] Unknown payload type ${payload.type}`);
        return [{ type: 'text', text: payload.content ?? `[unsupported type=${payload.type}]` }];
    }
  }
}
