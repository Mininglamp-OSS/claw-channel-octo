/**
 * Mock Octo HTTP API server for integration tests.
 *
 * Spins up a local node:http server that simulates the Octo bot endpoints:
 *   POST   /v1/bot/register
 *   GET    /v1/bot/events?last_event_id=N&limit=N
 *   POST   /v1/bot/sendMessage
 *   POST   /v1/bot/typing
 *   POST   /v1/bot/heartbeat
 *   POST   /v1/bot/events/{event_id}/ack
 *
 * The server records every request for assertion and exposes mutable state
 * so each test can stage the events the gateway should observe on its next
 * poll, override response codes, or count specific calls.
 */
import { createServer, type Server as HttpServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  method: string;
  path: string;
  body: unknown;
  headers: IncomingHttpHeaders;
}

export type PollHook = ((requestCount: number) => { status: number; body: unknown } | null) | null;

export class MockOctoServer {
  readonly requests: MockRequest[] = [];
  /** Events queued for the next GET /v1/bot/events poll. Drained on read. */
  events: unknown[] = [];
  registerStatus = 200;
  registerResponse: unknown = {
    robot_id: 'test_bot',
    im_token: 'test_token',
    ws_url: 'ws://localhost:1',
  };
  sendMessageStatus = 200;
  sendMessageResponse: unknown = { success: true };
  /** Optional hook to override poll responses on a per-call basis. */
  pollHook: PollHook = null;

  private pollCount = 0;
  private server!: HttpServer;
  private _port = 0;

  get port(): number { return this._port; }
  get url(): string { return `http://127.0.0.1:${this._port}`; }
  get pollRequestCount(): number { return this.pollCount; }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer | string) => { body += chunk.toString(); });
      req.on('end', () => {
        let parsed: unknown = null;
        if (body.length > 0) {
          try { parsed = JSON.parse(body); }
          catch { parsed = body; }
        }
        const url = req.url ?? '';
        const method = req.method ?? '';
        this.requests.push({ method, path: url, body: parsed, headers: req.headers });
        this.route(url, method, res);
      });
      req.on('error', () => { /* swallow */ });
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
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Reset request log + queued events; keep listening port. */
  reset(): void {
    this.requests.length = 0;
    this.events = [];
    this.pollCount = 0;
    this.pollHook = null;
    this.registerStatus = 200;
    this.sendMessageStatus = 200;
  }

  /** Count requests matching a predicate (e.g. by path). */
  countRequests(predicate: (r: MockRequest) => boolean): number {
    return this.requests.filter(predicate).length;
  }

  private route(url: string, method: string, res: import('node:http').ServerResponse): void {
    const json = (status: number, data: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (url === '/v1/bot/register' && method === 'POST') {
      return json(this.registerStatus, this.registerResponse);
    }
    if (url.startsWith('/v1/bot/events?') && method === 'GET') {
      this.pollCount += 1;
      if (this.pollHook) {
        const override = this.pollHook(this.pollCount);
        if (override) return json(override.status, override.body);
      }
      const drained = this.events.splice(0);
      return json(200, drained);
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
    if (/^\/v1\/bot\/events\/[^/]+\/ack$/.test(url) && method === 'POST') {
      return json(200, {});
    }
    res.writeHead(404);
    res.end('not found');
  }
}

/** Convenience: spin up a fresh server for a test suite. */
export async function startMockOctoServer(): Promise<MockOctoServer> {
  const srv = new MockOctoServer();
  await srv.start();
  return srv;
}

/** Wait for an event emitter to emit a named event, with a timeout. */
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
