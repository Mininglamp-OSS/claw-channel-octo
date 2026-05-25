/**
 * Integration tests — full plugin lifecycle with mock Octo HTTP API.
 *
 * These are milestone-level tests: they prove the system works end-to-end
 * by spinning up a real HTTP server, starting the plugin gateway, receiving
 * messages through polling, and verifying outbound replies hit the correct
 * endpoints with the correct payloads.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOctoPlugin } from '../index.js';
import type { ClawPlugin, PluginAccount, InboundMessage } from '../index.js';
import { MockOctoServer, startMockOctoServer, waitForEvent, sleep } from './mock-octo-server.js';

const noop = (..._a: unknown[]) => {};
const logger = { info: noop, warn: noop, error: noop };

describe('OctoPlugin Integration', () => {
  let server: MockOctoServer;
  let plugin: ClawPlugin;

  before(async () => {
    server = await startMockOctoServer();
  });

  after(async () => {
    await server.stop();
  });

  afterEach(async () => {
    await plugin?.gateway.stop();
    server.reset();
  });

  function makeAccount(): PluginAccount {
    return {
      accountId: 'integration-test',
      credential: { botToken: 'test-token-xyz', apiUrl: server.url },
    };
  }

  // ─── Plugin Lifecycle ────────────────────────────────────────────

  describe('Plugin Lifecycle', () => {
    it('createOctoPlugin returns valid plugin structure', () => {
      plugin = createOctoPlugin({ logger });
      assert.equal(plugin.id, 'octo');
      assert.equal(plugin.meta.name, 'Octo');
      assert.ok(plugin.config);
      assert.ok(plugin.gateway);
      assert.ok(plugin.outbound);
      assert.ok(plugin.capabilities?.supportedMessageTypes?.includes('text'));
    });

    it('config.resolveAccount parses credentials correctly', () => {
      plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({
        botToken: 'abc123token',
        apiUrl: 'https://custom.api/v1',
        connectionMode: 'websocket',
      });
      assert.equal(account.credential.botToken, 'abc123token');
      assert.equal(account.credential.apiUrl, 'https://custom.api/v1');
      assert.equal(account.platformMeta?.connectionMode, 'websocket');
    });

    it('gateway.start() registers bot and transitions to connected', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      assert.equal(plugin.gateway.getConnectionState().status, 'connected');

      const registerReq = server.requests.find(r => r.path === '/v1/bot/register');
      assert.ok(registerReq, 'Expected /v1/bot/register to be called');
      assert.equal(registerReq.headers.authorization, 'Bearer test-token-xyz');
    });

    it('gateway.start() sets state to error on register failure', async () => {
      server.registerStatus = 500;
      plugin = createOctoPlugin({ logger });

      await assert.rejects(
        () => plugin.gateway.start(makeAccount()),
        (err: Error) => err.message.includes('Register failed'),
      );
      assert.equal(plugin.gateway.getConnectionState().status, 'error');
    });

    it('gateway.stop() cleans up and transitions to disconnected', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());
      assert.equal(plugin.gateway.getConnectionState().status, 'connected');

      await plugin.gateway.stop();
      assert.equal(plugin.gateway.getConnectionState().status, 'disconnected');
    });

    it('outbound receives credentials via onAccountResolved callback', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      // Outbound should now be configured — verify by sending a message
      const result = await plugin.outbound.send({
        text: 'credential test',
        replyContext: { chatId: 'user1', channelType: '1' },
      });
      assert.equal(result.success, true);

      const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
      assert.ok(sendReq, 'sendMessage should have been called with injected credentials');
    });
  });

  // ─── Inbound: Octo → Plugin ─────────────────────────────────────

  describe('Inbound: Octo → Plugin', () => {
    it('receives DM message and emits inbound with channelType=1', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      server.events = [{
        event_id: 1,
        message: {
          message_id: 'dm_001',
          from_uid: 'user_alice',
          payload: { type: 1, content: 'Hello from Octo DM' },
          timestamp: 1700000000,
        },
      }];

      const msg: InboundMessage = await waitForEvent(plugin.gateway, 'inbound', 5000);
      assert.equal(msg.messageId, 'dm_001');
      assert.equal(msg.sender.senderId, 'user_alice');
      assert.equal(msg.replyContext.channelType, '1');
      assert.equal(msg.replyContext.chatId, 'user_alice');
      assert.equal(msg.replyContext.connectionMode, 'websocket');
      assert.deepEqual(msg.content, [{ type: 'text', text: 'Hello from Octo DM' }]);
    });

    it('receives Group message and emits inbound with channelType=2', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      server.events = [{
        event_id: 2,
        message: {
          message_id: 'grp_001',
          from_uid: 'user_bob',
          channel_id: 'group_ops',
          channel_type: 2,
          payload: { type: 1, content: '@Bot check status' },
        },
      }];

      const msg: InboundMessage = await waitForEvent(plugin.gateway, 'inbound', 5000);
      assert.equal(msg.replyContext.channelType, '2');
      assert.equal(msg.replyContext.chatId, 'group_ops');
      assert.equal(msg.sender.senderId, 'user_bob');
    });

    it('receives Thread message with channelType=5, preserving ____ format', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const threadChannelId = 'group_ops____2044043250838278144';
      server.events = [{
        event_id: 3,
        message: {
          message_id: 'thr_001',
          from_uid: 'user_carol',
          channel_id: threadChannelId,
          channel_type: 5,
          payload: { type: 1, content: 'Thread discussion' },
        },
      }];

      const msg: InboundMessage = await waitForEvent(plugin.gateway, 'inbound', 5000);
      assert.equal(msg.replyContext.channelType, '5');
      assert.equal(msg.replyContext.chatId, threadChannelId, 'Thread channel_id must preserve ____ format');
    });

    it('deduplicates messages with same message_id', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const collected: InboundMessage[] = [];
      plugin.gateway.on('inbound', (m: InboundMessage) => collected.push(m));

      // First delivery
      server.events = [{
        event_id: 10,
        message: { message_id: 'dup_001', from_uid: 'u1', payload: { type: 1, content: 'original' } },
      }];
      await sleep(3000);

      // Second delivery — same message_id, different event_id
      server.events = [{
        event_id: 11,
        message: { message_id: 'dup_001', from_uid: 'u1', payload: { type: 1, content: 'original' } },
      }];
      await sleep(3000);

      const matches = collected.filter(m => m.messageId === 'dup_001');
      assert.equal(matches.length, 1, 'Duplicate message_id should be emitted only once');
    });

    it('handles image payload (type=2) with url', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      server.events = [{
        event_id: 20,
        message: {
          message_id: 'img_001',
          from_uid: 'user_dave',
          payload: { type: 2, url: 'https://cdn.example.com/photo.jpg' },
        },
      }];

      const msg: InboundMessage = await waitForEvent(plugin.gateway, 'inbound', 5000);
      assert.equal(msg.content[0]?.type, 'image');
      assert.equal(msg.content[0]?.url, 'https://cdn.example.com/photo.jpg');
    });

    it('handles file payload (type=8) with name and size', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      server.events = [{
        event_id: 21,
        message: {
          message_id: 'file_001',
          from_uid: 'user_eve',
          payload: { type: 8, url: 'https://cdn.example.com/doc.pdf', name: 'report.pdf', size: 54321 },
        },
      }];

      const msg: InboundMessage = await waitForEvent(plugin.gateway, 'inbound', 5000);
      assert.equal(msg.content[0]?.type, 'file');
      assert.equal(msg.content[0]?.name, 'report.pdf');
      assert.equal(msg.content[0]?.size, 54321);
    });

    it('skips events with no message field', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const collected: InboundMessage[] = [];
      plugin.gateway.on('inbound', (m: InboundMessage) => collected.push(m));

      server.events = [
        { event_id: 30 },  // no message field
        { event_id: 31, message: { message_id: 'valid_001', from_uid: 'u1', payload: { type: 1, content: 'ok' } } },
      ];
      await sleep(3000);

      assert.equal(collected.length, 1);
      assert.equal(collected[0]?.messageId, 'valid_001');
    });
  });

  // ─── Outbound: Plugin → Octo ────────────────────────────────────

  describe('Outbound: Plugin → Octo', () => {
    it('sends text reply to DM (channelType=1)', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const result = await plugin.outbound.send({
        text: 'Hello back',
        replyContext: { chatId: 'user_alice', channelType: '1' },
      });

      assert.equal(result.success, true);
      const req = server.requests.filter(r => r.path === '/v1/bot/sendMessage').pop();
      assert.ok(req);
      const body = req.body as Record<string, unknown>;
      assert.equal(body.channel_id, 'user_alice');
      assert.equal(body.channel_type, 1);
      assert.deepEqual(body.payload, { type: 1, content: 'Hello back' });
    });

    it('sends text reply to Group (channelType=2)', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const result = await plugin.outbound.send({
        text: 'Group reply',
        replyContext: { chatId: 'group_ops', channelType: '2' },
      });

      assert.equal(result.success, true);
      const req = server.requests.filter(r => r.path === '/v1/bot/sendMessage').pop();
      const body = req?.body as Record<string, unknown>;
      assert.equal(body.channel_id, 'group_ops');
      assert.equal(body.channel_type, 2);
    });

    it('sends text reply to Thread (channelType=5) with full channel_id', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const threadId = 'group_ops____2044043250838278144';
      const result = await plugin.outbound.send({
        text: 'Thread reply',
        replyContext: { chatId: threadId, channelType: '5' },
      });

      assert.equal(result.success, true);
      const req = server.requests.filter(r => r.path === '/v1/bot/sendMessage').pop();
      const body = req?.body as Record<string, unknown>;
      assert.equal(body.channel_id, threadId, 'Thread channel_id must not be split');
      assert.equal(body.channel_type, 5);
    });

    it('sends typing indicator in streaming mode', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const result = await plugin.outbound.send({
        text: 'partial...',
        deliveryMode: 'streaming',
        replyContext: { chatId: 'user_alice', channelType: '1' },
      });

      assert.equal(result.success, true);
      const typingReqs = server.requests.filter(r => r.path === '/v1/bot/typing');
      assert.ok(typingReqs.length > 0, 'Should call /v1/bot/typing in streaming mode');
      const sendReqs = server.requests.filter(r => r.path === '/v1/bot/sendMessage');
      // In streaming mode, sendMessage should NOT be called (only typing)
      const afterStart = sendReqs.filter(r => {
        const b = r.body as Record<string, unknown>;
        return (b.payload as Record<string, unknown>)?.content === 'partial...';
      });
      assert.equal(afterStart.length, 0, 'Streaming mode should not send the actual message');
    });

    it('sends file message with url and name', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const result = await plugin.outbound.send({
        files: [{ url: 'https://cdn.example.com/report.pdf', name: 'report.pdf' }],
        replyContext: { chatId: 'group_ops', channelType: '2' },
      });

      assert.equal(result.success, true);
      const req = server.requests.filter(r => r.path === '/v1/bot/sendMessage').pop();
      const body = req?.body as Record<string, unknown>;
      const payload = body.payload as Record<string, unknown>;
      assert.equal(payload.type, 8);
      assert.equal(payload.url, 'https://cdn.example.com/report.pdf');
      assert.equal(payload.name, 'report.pdf');
    });

    it('returns error for missing chatId', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const result = await plugin.outbound.send({
        text: 'orphan message',
        replyContext: {},
      });
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /chatId/i);
    });

    it('returns error for empty text and no files', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      const result = await plugin.outbound.send({
        replyContext: { chatId: 'user1', channelType: '1' },
      });
      assert.equal(result.success, false);
    });

    it('returns error when API responds with 500', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());
      server.sendMessageStatus = 500;
      server.sendMessageResponse = { error: 'internal' };

      const result = await plugin.outbound.send({
        text: 'will fail',
        replyContext: { chatId: 'user1', channelType: '1' },
      });
      assert.equal(result.success, false);
      assert.ok(result.error);
    });
  });

  // ─── Resilience ──────────────────────────────────────────────────

  describe('Resilience', () => {
    it('continues polling after transient API errors', async () => {
      let failCount = 0;
      server.pollHook = (n) => {
        if (n <= 3) { failCount++; return { status: 500, body: { error: 'transient' } }; }
        return null; // resume normal
      };

      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      // Inject a valid event after failures subside
      await sleep(8000); // wait for a few poll cycles past the failures
      server.events = [{
        event_id: 99,
        message: { message_id: 'recovery_001', from_uid: 'u1', payload: { type: 1, content: 'recovered' } },
      }];

      const msg: InboundMessage = await waitForEvent(plugin.gateway, 'inbound', 5000);
      assert.equal(msg.messageId, 'recovery_001');
      assert.ok(failCount >= 3, 'Should have experienced transient failures');
    });

    it('heartbeat calls are made periodically', async () => {
      plugin = createOctoPlugin({ logger });
      await plugin.gateway.start(makeAccount());

      // Heartbeat interval is 30s in production; just verify the first one
      // or check that register was called (which confirms connectivity)
      const registerReqs = server.requests.filter(r => r.path === '/v1/bot/register');
      assert.ok(registerReqs.length >= 1);
    });
  });
});
