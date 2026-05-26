import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';

interface Logger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

/** Decoded inbound message yielded via the 'message' event. */
export interface OctoWsMessage {
  messageId: string;
  messageSeq: number;
  channelId: string;
  channelType: number;
  fromUid: string;
  timestamp?: number;
  payload: { type: number; content?: string; url?: string; name?: string; size?: number; [k: string]: unknown };
}

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: string;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ConnectResult {
  serverKey?: string;
  salt?: string;
  timeDiff?: number;
  reasonCode: number;
}

const PING_INTERVAL_MS = 25_000;
const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_BACKOFF_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const DEVICE_FLAG_WEB = 2;

/**
 * OctoWebSocket — JSON-RPC over WebSocket client for the Octo IM protocol.
 *
 * Lifecycle:
 *   connect(wsUrl, uid, token) → WebSocket open → JSON-RPC `connect` →
 *   ConnectResult{ reasonCode: 0 } → start ping loop → ready.
 *
 * Inbound `recv` notifications are decoded (base64 payload → JSON) and
 * emitted via the 'message' event. Each is auto-acked with `recvack`.
 *
 * On unexpected disconnect, the client auto-reconnects with exponential
 * backoff until disconnect() is called.
 */
export class OctoWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private wsUrl = '';
  private uid = '';
  private token = '';
  private deviceId = '';
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private isReconnecting = false;
  private connected = false;
  private stopped = false;
  private connectRequestId = '';
  private pending: { resolve: () => void; reject: (err: Error) => void } | null = null;

  constructor(private logger: Logger) { super(); }

  isConnected(): boolean { return this.connected; }

  /**
   * Open a WebSocket and complete the JSON-RPC `connect` handshake.
   * Rejects if the handshake fails or times out. Resolves once ConnectResult
   * (reasonCode 0) is received; afterwards, reconnects happen in background.
   */
  async connect(wsUrl: string, uid: string, token: string): Promise<void> {
    this.wsUrl = wsUrl;
    this.uid = uid;
    this.token = token;
    this.deviceId = `claw_${randomUUID()}`;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.isReconnecting = false;
    return this.openAndHandshake();
  }

  /** Close the socket and stop reconnect attempts. Safe to call multiple times. */
  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.pending) {
      this.pending.reject(new Error('disconnect() called before handshake completed'));
      this.pending = null;
    }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
  }

  private openAndHandshake(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      this.pending = { resolve, reject };

      this.connectTimer = setTimeout(() => {
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          try { ws.terminate(); } catch { /* ignore */ }
          p.reject(new Error(`WebSocket handshake timed out after ${CONNECT_TIMEOUT_MS}ms`));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        this.connectRequestId = randomUUID();
        const req: JsonRpcRequest = {
          jsonrpc: '2.0',
          method: 'connect',
          params: {
            uid: this.uid,
            token: this.token,
            deviceId: this.deviceId,
            deviceFlag: DEVICE_FLAG_WEB,
          },
          id: this.connectRequestId,
        };
        this.sendRaw(req);
      });

      ws.on('message', (data: RawData) => this.handleMessage(data));

      ws.on('error', (err: Error) => {
        this.logger.warn('[OctoWebSocket] ws error:', err.message);
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
          p.reject(err);
        }
        // Do NOT schedule reconnect here — `close` handler is the single
        // scheduler. ws emits 'close' after 'error', so the close path runs.
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.stopPing();
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          p.reject(new Error(`WebSocket closed before handshake (code=${code}, reason=${reason.toString()})`));
          return;
        }
        if (wasConnected) {
          this.emit('disconnect', { code, reason: reason.toString() });
          this.logger.warn(`[OctoWebSocket] disconnected (code=${code})`);
        }
        if (!this.stopped && !this.isReconnecting) this.scheduleReconnect();
      });
    });
  }

  private handleMessage(data: RawData): void {
    let parsed: JsonRpcRequest & JsonRpcResponse;
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf-8')
        : data.toString('utf-8');
      parsed = JSON.parse(text);
    } catch (err) {
      this.logger.warn('[OctoWebSocket] failed to parse frame:', err instanceof Error ? err.message : err);
      return;
    }

    // JSON-RPC response correlated to our `connect` request id.
    // Any other id (or no id) for a response frame is ignored — prevents
    // a stray late response from re-entering the handshake handler.
    if ((parsed.result !== undefined || parsed.error !== undefined)
        && parsed.id !== undefined && parsed.id === this.connectRequestId) {
      this.handleHandshakeResponse(parsed);
      return;
    }

    // JSON-RPC notification / request
    if (parsed.method === 'recv') {
      this.handleRecv(parsed.params ?? {});
      return;
    }
    if (parsed.method === 'pong') {
      return;
    }
    if (parsed.method === 'disconnect') {
      this.logger.warn('[OctoWebSocket] server requested disconnect:', JSON.stringify(parsed.params ?? {}));
      try { this.ws?.close(); } catch { /* ignore */ }
      return;
    }
  }

  private handleHandshakeResponse(resp: JsonRpcResponse): void {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    const pending = this.pending;
    this.pending = null;

    if (resp.error) {
      // Reject and immediately tear down so the orphan socket can't trigger
      // a reconnect loop on auth/permission failures.
      this.stopped = true;
      try { this.ws?.terminate(); } catch { /* ignore */ }
      this.ws = null;
      pending?.reject(new Error(`connect rpc error: ${resp.error.message} (code=${resp.error.code})`));
      return;
    }
    const result = (resp.result ?? {}) as unknown as ConnectResult;
    if (result.reasonCode !== 0) {
      this.stopped = true;
      try { this.ws?.terminate(); } catch { /* ignore */ }
      this.ws = null;
      pending?.reject(new Error(`connect refused: reasonCode=${result.reasonCode}`));
      return;
    }
    this.connected = true;
    this.reconnectAttempt = 0;
    this.isReconnecting = false;
    this.startPing();
    this.emit('connect', result);
    this.logger.info('[OctoWebSocket] connected');
    pending?.resolve();
  }

  private handleRecv(params: Record<string, unknown>): void {
    const messageId = String(params.messageId ?? '');
    const messageSeq = Number(params.messageSeq ?? 0);
    const channelId = String(params.channelId ?? '');
    const channelType = Number(params.channelType ?? 0);
    const fromUid = String(params.fromUid ?? '');
    const timestamp = typeof params.timestamp === 'number' ? params.timestamp : undefined;

    // WuKongIM JSON-RPC protocol: payload is a direct JSON object, not base64
    let payload: OctoWsMessage['payload'];
    if (typeof params.payload === 'object' && params.payload !== null) {
      payload = params.payload as OctoWsMessage['payload'];
    } else if (typeof params.payload === 'string') {
      // Legacy/compat: some older versions may send base64-encoded JSON
      try {
        const decoded = Buffer.from(params.payload, 'base64').toString('utf-8');
        payload = JSON.parse(decoded) as OctoWsMessage['payload'];
      } catch {
        payload = { type: 1, content: params.payload };
      }
    } else {
      payload = { type: 0 };
    }

    const msg: OctoWsMessage = { messageId, messageSeq, channelId, channelType, fromUid, timestamp, payload };
    this.emit('message', msg);
    this.sendAck(messageId, messageSeq, params.header);
  }

  private sendAck(messageId: string, messageSeq: number, header: unknown): void {
    const ack: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'recvack',
      params: {
        header: header ?? {},
        messageId,
        messageSeq,
      },
    };
    this.sendRaw(ack);
  }

  private sendRaw(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.logger.warn('[OctoWebSocket] send failed:', err instanceof Error ? err.message : err);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendRaw({ jsonrpc: '2.0', method: 'ping', params: {}, id: randomUUID() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.stopped = true;
      this.isReconnecting = false;
      this.logger.error(`[OctoWebSocket] giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      this.emit('fatal', new Error(`reconnect limit reached (${MAX_RECONNECT_ATTEMPTS})`));
      return;
    }
    this.isReconnecting = true;
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempt), RECONNECT_BACKOFF_MAX_MS);
    this.reconnectAttempt += 1;
    this.logger.info(`[OctoWebSocket] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) { this.isReconnecting = false; return; }
      this.openAndHandshake().catch((err) => {
        this.logger.warn('[OctoWebSocket] reconnect failed:', err instanceof Error ? err.message : err);
        // Don't recurse synchronously — the failed openAndHandshake will have
        // either rejected from a `close` (which schedules a new reconnect) or
        // never opened. Clear the flag so `close` can schedule.
        this.isReconnecting = false;
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
  }
}
