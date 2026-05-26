/**
 * Mock Octo server for integration tests.
 *
 * Provides both HTTP REST API (register, sendMessage, heartbeat, etc.)
 * and a WebSocket server implementing the JSON-RPC protocol used by
 * OctoWebSocket.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

export interface MockRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export class MockOctoServer {
  readonly requests: MockRequest[] = [];
  registerStatus = 200;
  sendMessageStatus = 200;
  sendMessageResponse: unknown = { success: true, message_id: 'mock_msg_001' };

  private server!: HttpServer;
  private wss!: WebSocketServer;
  private wsClients: WebSocket[] = [];
  private _port = 0;

  get port(): number { return this._port; }
  get url(): string { return `http://127.0.0.1:${this._port}`; }
  get wsUrl(): string { return `ws://127.0.0.1:${this._port}`; }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer | string) => { body += chunk.toString(); });
      req.on('end', () => {
        let parsed: unknown = null;
        if (body.length > 0) {
          try { parsed = JSON.parse(body); } catch { parsed = body; }
        }
        const url = req.url ?? '';
        const method = req.method ?? '';
        this.requests.push({ method, path: url, body: parsed, headers: req.headers as Record<string, string | string[] | undefined> });
        this.route(url, method, res);
      });
      req.on('error', () => { /* swallow */ });
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      this.wsClients.push(ws);
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => this.handleWsMessage(ws, data as Buffer));
      ws.on('close', () => {
        this.wsClients = this.wsClients.filter(c => c !== ws);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as AddressInfo;
        this._port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.wsClients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.wsClients = [];
    if (this.wss) await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.server) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.registerStatus = 200;
    this.sendMessageStatus = 200;
    this.sendMessageResponse = { success: true, message_id: 'mock_msg_001' };
  }

  countRequests(predicate: (r: MockRequest) => boolean): number {
    return this.requests.filter(predicate).length;
  }

  /**
   * Inject a message to all connected WebSocket clients (simulates Octo
   * sending a chat message to the bot).
   */
  injectMessage(msg: {
    messageId: string;
    messageSeq?: number;
    channelId?: string;
    channelType?: number;
    fromUid: string;
    payload: Record<string, unknown>;
    timestamp?: number;
  }): void {
    const payloadB64 = Buffer.from(JSON.stringify(msg.payload)).toString('base64');
    const notification = {
      jsonrpc: '2.0',
      method: 'recv',
      params: {
        header: {},
        messageId: msg.messageId,
        messageSeq: msg.messageSeq ?? 1,
        channelId: msg.channelId ?? '',
        channelType: msg.channelType ?? 1,
        fromUid: msg.fromUid,
        payload: payloadB64,
        timestamp: msg.timestamp ?? Math.floor(Date.now() / 1000),
      },
    };
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(notification));
      }
    }
  }

  get connectedWsClients(): number { return this.wsClients.length; }

  private handleWsMessage(ws: WebSocket, data: Buffer): void {
    let parsed: { jsonrpc?: string; method?: string; params?: Record<string, unknown>; id?: string };
    try {
      parsed = JSON.parse(String(data));
    } catch { return; }

    if (parsed.method === 'connect') {
      // Respond with successful handshake
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: { serverKey: 'test', salt: 'test', timeDiff: 0, reasonCode: 0 },
      }));
      return;
    }
    if (parsed.method === 'ping') {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
      return;
    }
    if (parsed.method === 'recvack') {
      // Ack received — no-op for tests
      return;
    }
  }

  private route(url: string, method: string, res: import('node:http').ServerResponse): void {
    const json = (status: number, data: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (url === '/v1/bot/register' && method === 'POST') {
      if (this.registerStatus >= 400) {
        return json(this.registerStatus, { error: 'register failed' });
      }
      return json(200, {
        robot_id: 'test_bot',
        im_token: 'test_im_token',
        ws_url: this.wsUrl,
        api_url: this.url,
        owner_uid: 'owner_001',
      });
    }
    if (url === '/v1/bot/sendMessage' && method === 'POST') {
      return json(this.sendMessageStatus, this.sendMessageResponse);
    }
    if (url === '/v1/bot/typing' && method === 'POST') {
      return json(200, {});
    }
    if (url === '/v1/bot/heartbeat' && method === 'POST') {
      return json(200, {});
    }
    if (url === '/v1/bot/message/edit' && method === 'POST') {
      return json(200, { success: true });
    }
    if (url === '/v1/bot/file/upload' && method === 'POST') {
      return json(200, { url: 'https://octo.storage/uploaded-file.pdf', name: 'file.pdf', size: 1024 });
    }
    res.writeHead(404);
    res.end('not found');
  }
}

export async function startMockOctoServer(): Promise<MockOctoServer> {
  const srv = new MockOctoServer();
  await srv.start();
  return srv;
}

export function waitForEvent<T = unknown>(
  emitter: { once: (ev: string, fn: (data: T) => void) => void; off?: (ev: string, fn: (data: T) => void) => void },
  event: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onEvent = (data: T): void => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(() => {
      if (emitter.off) emitter.off(event, onEvent);
      reject(new Error(`Timeout waiting for "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);
    emitter.once(event, onEvent);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
