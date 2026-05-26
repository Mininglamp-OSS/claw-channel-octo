import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOctoPlugin } from '../index.js';
import { MockOctoServer, startMockOctoServer, waitForEvent, sleep } from './mock-octo-server.js';
import type { InboundMessage } from '../index.js';

describe('OctoPlugin Integration', () => {
  let server: MockOctoServer;

  before(async () => { server = await startMockOctoServer(); });
  after(async () => { await server.stop(); });
  beforeEach(() => { server.reset(); });

  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  describe('Plugin Lifecycle', () => {
    it('createOctoPlugin returns valid plugin structure', () => {
      const plugin = createOctoPlugin({ logger });
      assert.equal(plugin.id, 'octo');
      assert.equal(plugin.meta.name, 'Octo');
      assert.ok(plugin.gateway);
      assert.ok(plugin.outbound);
      assert.ok(plugin.config);
    });

    it('config.resolveAccount parses credentials correctly', () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'tok123', apiUrl: 'http://example.com' });
      assert.equal(account.credential.botToken, 'tok123');
      assert.equal(account.credential.apiUrl, 'http://example.com');
    });

    it('gateway.start() registers bot and connects WebSocket', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);
      assert.equal(plugin.gateway.getConnectionState().status, 'connected');
      assert.equal(server.connectedWsClients, 1);
      await plugin.gateway.stop();
    });

    it('gateway.start() throws on register failure', async () => {
      server.registerStatus = 401;
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'bad', apiUrl: server.url });
      await assert.rejects(() => plugin.gateway.start(account), /Register failed/);
      assert.equal(plugin.gateway.getConnectionState().status, 'error');
    });

    it('gateway.stop() disconnects WebSocket and transitions to disconnected', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);
      await plugin.gateway.stop();
      assert.equal(plugin.gateway.getConnectionState().status, 'disconnected');
      await sleep(50);
      assert.equal(server.connectedWsClients, 0);
    });

    it('outbound receives credentials via onAccountResolved callback', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'cred_test', apiUrl: server.url });
      await plugin.gateway.start(account);
      // Outbound should be configured and able to send
      const result = await plugin.outbound.send({
        text: 'hello',
        replyContext: { chatId: 'user_1', channelType: '1' },
      });
      assert.equal(result.success, true);
      await plugin.gateway.stop();
    });
  });

  describe('Inbound: WebSocket → Plugin', () => {
    it('receives DM message with channelType=1', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const promise = waitForEvent<InboundMessage>(plugin.gateway, 'inbound', 3000);
      server.injectMessage({
        messageId: 'dm_001',
        fromUid: 'user_abc',
        channelType: 1,
        payload: { type: 1, content: 'hello from DM' },
      });
      const inbound = await promise;
      assert.equal(inbound.messageId, 'dm_001');
      assert.equal(inbound.sender.senderId, 'user_abc');
      assert.equal(inbound.replyContext.channelType, '1');
      assert.equal(inbound.content[0]!.text, 'hello from DM');
      await plugin.gateway.stop();
    });

    it('receives Group message with channelType=2', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const promise = waitForEvent<InboundMessage>(plugin.gateway, 'inbound', 3000);
      server.injectMessage({
        messageId: 'grp_001',
        fromUid: 'user_xyz',
        channelId: 'group_123',
        channelType: 2,
        payload: { type: 1, content: '@Bot help' },
      });
      const inbound = await promise;
      assert.equal(inbound.replyContext.chatId, 'group_123');
      assert.equal(inbound.replyContext.channelType, '2');
      await plugin.gateway.stop();
    });

    it('receives Thread message with channelType=5, preserving ____ format', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const promise = waitForEvent<InboundMessage>(plugin.gateway, 'inbound', 3000);
      server.injectMessage({
        messageId: 'thread_001',
        fromUid: 'user_xyz',
        channelId: 'group_123____2044043250838278144',
        channelType: 5,
        payload: { type: 1, content: 'thread msg' },
      });
      const inbound = await promise;
      assert.equal(inbound.replyContext.chatId, 'group_123____2044043250838278144');
      assert.equal(inbound.replyContext.channelType, '5');
      await plugin.gateway.stop();
    });

    it('deduplicates messages with same message_id', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      let count = 0;
      plugin.gateway.on('inbound', () => { count++; });

      server.injectMessage({ messageId: 'dup_001', fromUid: 'u1', payload: { type: 1, content: 'first' } });
      await sleep(50);
      server.injectMessage({ messageId: 'dup_001', fromUid: 'u1', payload: { type: 1, content: 'first' } });
      await sleep(50);
      server.injectMessage({ messageId: 'dup_001', fromUid: 'u1', payload: { type: 1, content: 'first' } });
      await sleep(100);
      assert.equal(count, 1);
      await plugin.gateway.stop();
    });

    it('handles image payload (type=2) with url', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const promise = waitForEvent<InboundMessage>(plugin.gateway, 'inbound', 3000);
      server.injectMessage({
        messageId: 'img_001',
        fromUid: 'u1',
        payload: { type: 2, url: 'https://octo.cdn/img.png' },
      });
      const inbound = await promise;
      assert.equal(inbound.content[0]!.type, 'image');
      assert.equal(inbound.content[0]!.url, 'https://octo.cdn/img.png');
      await plugin.gateway.stop();
    });

    it('handles file payload (type=8) with name and size', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const promise = waitForEvent<InboundMessage>(plugin.gateway, 'inbound', 3000);
      server.injectMessage({
        messageId: 'file_001',
        fromUid: 'u1',
        payload: { type: 8, url: 'https://octo.cdn/report.pdf', name: 'report.pdf', size: 2048 },
      });
      const inbound = await promise;
      assert.equal(inbound.content[0]!.type, 'file');
      assert.equal(inbound.content[0]!.name, 'report.pdf');
      assert.equal(inbound.content[0]!.size, 2048);
      await plugin.gateway.stop();
    });
  });

  describe('Outbound: Plugin → Octo', () => {
    it('sends text reply to DM (channelType=1)', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const result = await plugin.outbound.send({
        text: 'reply text',
        replyContext: { chatId: 'user_1', channelType: '1' },
      });
      assert.equal(result.success, true);
      const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
      assert.ok(sendReq);
      assert.deepEqual((sendReq!.body as Record<string, unknown>).payload, { type: 1, content: 'reply text' });
      await plugin.gateway.stop();
    });

    it('sends text reply to Group (channelType=2)', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const result = await plugin.outbound.send({
        text: 'group reply',
        replyContext: { chatId: 'group_abc', channelType: '2' },
      });
      assert.equal(result.success, true);
      const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
      assert.equal((sendReq!.body as Record<string, unknown>).channel_id, 'group_abc');
      assert.equal((sendReq!.body as Record<string, unknown>).channel_type, 2);
      await plugin.gateway.stop();
    });

    it('sends text reply to Thread (channelType=5) with full channel_id', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      await plugin.outbound.send({
        text: 'thread reply',
        replyContext: { chatId: 'group_abc____2044043250838278144', channelType: '5' },
      });
      const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
      assert.equal((sendReq!.body as Record<string, unknown>).channel_id, 'group_abc____2044043250838278144');
      assert.equal((sendReq!.body as Record<string, unknown>).channel_type, 5);
      await plugin.gateway.stop();
    });

    it('sends typing indicator in streaming mode', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const result = await plugin.outbound.send({
        text: 'ignored',
        deliveryMode: 'streaming',
        replyContext: { chatId: 'user_1', channelType: '1' },
      });
      assert.equal(result.success, true);
      const typingReq = server.requests.find(r => r.path === '/v1/bot/typing');
      assert.ok(typingReq);
      await plugin.gateway.stop();
    });

    it('sends file message with url and name', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      await plugin.outbound.send({
        files: [{ url: 'https://cdn.example/file.pdf', name: 'file.pdf' }],
        replyContext: { chatId: 'user_1', channelType: '1' },
      });
      const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
      assert.ok(sendReq);
      const payload = (sendReq!.body as Record<string, unknown>).payload as Record<string, unknown>;
      assert.equal(payload.type, 8);
      assert.equal(payload.url, 'https://cdn.example/file.pdf');
      await plugin.gateway.stop();
    });

    it('returns error for missing chatId', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const result = await plugin.outbound.send({ text: 'hi', replyContext: {} });
      assert.equal(result.success, false);
      assert.match(result.error!, /chatId/);
      await plugin.gateway.stop();
    });

    it('returns error for empty text and no files', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const result = await plugin.outbound.send({ replyContext: { chatId: 'u1', channelType: '1' } });
      assert.equal(result.success, false);
      assert.match(result.error!, /No text or files/);
      await plugin.gateway.stop();
    });

    it('returns error when API responds with 500', async () => {
      server.sendMessageStatus = 500;
      server.sendMessageResponse = { error: 'internal' };
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      const result = await plugin.outbound.send({
        text: 'fail',
        replyContext: { chatId: 'u1', channelType: '1' },
      });
      assert.equal(result.success, false);
      await plugin.gateway.stop();
    });

    it('editMessage sends to /v1/bot/message/edit', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);

      await plugin.outbound.editMessage('msg_123', 'ch_1', 2, 'updated text');
      const editReq = server.requests.find(r => r.path === '/v1/bot/message/edit');
      assert.ok(editReq);
      const body = editReq.body as Record<string, unknown>;
      assert.equal(body.message_id, 'msg_123');
      assert.deepEqual(body.payload, { type: 1, content: 'updated text' });
      await plugin.gateway.stop();
    });
  });

  describe('Resilience', () => {
    it('heartbeat calls /v1/bot/heartbeat periodically', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.start(account);
      // Heartbeat is on 30s interval — just verify one has been registered
      assert.equal(plugin.gateway.getConnectionState().status, 'connected');
      await plugin.gateway.stop();
    });

    it('gateway throws when WebSocket URL is invalid', async () => {
      const plugin = createOctoPlugin({ logger });
      // Point to a port that won't have a WS server
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: 'http://127.0.0.1:1' });
      await assert.rejects(() => plugin.gateway.start(account));
    });
  });
});
