import { Centrifuge, type Subscription } from 'centrifuge';
import WebSocket from 'ws';
import type { AGPMessage } from './agp-types.js';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

export type PublicationHandler = (data: unknown) => void;

export class CentrifugeClient {
  private client: Centrifuge | null = null;
  private subscriptions = new Map<string, Subscription>();

  constructor(private logger: Logger) {}

  async connect(url: string, connectionToken: string): Promise<void> {
    this.client = new Centrifuge(url, {
      token: connectionToken,
      websocket: WebSocket as unknown as typeof globalThis.WebSocket,
    });

    this.client.on('connecting', (ctx) => {
      this.logger.info('centrifuge: connecting', { code: ctx.code });
    });
    this.client.on('connected', (ctx) => {
      this.logger.info('centrifuge: connected', { client: ctx.client });
    });
    this.client.on('disconnected', (ctx) => {
      this.logger.warn('centrifuge: disconnected', {
        code: ctx.code,
        reason: ctx.reason,
      });
    });
    this.client.on('error', (ctx) => {
      this.logger.error('centrifuge: error', {
        type: ctx.error.type,
        message: ctx.error.message,
      });
    });

    return new Promise<void>((resolve, reject) => {
      const onConnected = () => {
        this.client?.removeListener('error', onError);
        resolve();
      };
      const onError = (ctx: { error: { message: string } }) => {
        this.client?.removeListener('connected', onConnected);
        reject(new Error(`centrifuge connect failed: ${ctx.error.message}`));
      };
      this.client?.once('connected', onConnected);
      this.client?.once('error', onError);
      this.client?.connect();
    });
  }

  subscribe(
    channel: string,
    subscriptionToken: string,
    onPublication: PublicationHandler,
  ): void {
    if (!this.client) throw new Error('centrifuge not connected');
    const existing = this.subscriptions.get(channel);
    if (existing) {
      existing.removeAllListeners();
      existing.unsubscribe();
      this.client.removeSubscription(existing);
    }
    const sub = this.client.newSubscription(channel, {
      token: subscriptionToken,
    });
    sub.on('subscribed', () => {
      this.logger.info('centrifuge: subscribed', { channel });
    });
    sub.on('unsubscribed', (ctx) => {
      this.logger.warn('centrifuge: unsubscribed', {
        channel,
        code: ctx.code,
      });
    });
    sub.on('error', (ctx) => {
      this.logger.error('centrifuge: subscription error', {
        channel,
        message: ctx.error.message,
      });
    });
    sub.on('publication', (ctx) => {
      try {
        onPublication(ctx.data);
      } catch (err) {
        this.logger.error('centrifuge: publication handler threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    sub.subscribe();
    this.subscriptions.set(channel, sub);
  }

  async publish(channel: string, data: AGPMessage): Promise<void> {
    if (!this.client) throw new Error('centrifuge not connected');
    await this.client.publish(channel, data);
  }

  disconnect(): void {
    for (const [, sub] of this.subscriptions) {
      try {
        sub.removeAllListeners();
        sub.unsubscribe();
      } catch {
        // ignore
      }
    }
    this.subscriptions.clear();
    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }
}
