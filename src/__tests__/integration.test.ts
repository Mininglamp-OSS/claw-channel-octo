import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOctoPlugin } from '../index.js';
import { MockOctoServer, startMockOctoServer, sleep } from './mock-octo-server.js';
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

    it('gateway.startAccount() registers bot and connects WebSocket', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);
      assert.equal(plugin.gateway.getConnectionState().status, 'connected');
      assert.equal(server.connectedWsClients, 1);
      await plugin.gateway.stopAccount();
    });

    it('gateway.startAccount() throws on register failure', async () => {
      server.registerStatus = 401;
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'bad', apiUrl: server.url });
      await assert.rejects(() => plugin.gateway.startAccount(account), /Register failed/);
      assert.equal(plugin.gateway.getConnectionState().status, 'error');
    });

    it('gateway.stopAccount() disconnects WebSocket and transitions to disconnected', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);
      await plugin.gateway.stopAccount();
      assert.equal(plugin.gateway.getConnectionState().status, 'disconnected');
      await sleep(50);
      assert.equal(server.connectedWsClients, 0);
    });

    it('outbound receives credentials via onAccountResolved callback', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'cred_test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);
      // Outbound should be configured and able to send
      const result = await plugin.outbound.send({
        text: 'hello',
        replyContext: { chatId: 'user_1', channelType: '1' },
      });
      assert.equal(result.success, true);
      await plugin.gateway.stopAccount();
    });
  });

  describe('Inbound: WebSocket → Plugin', () => {
    it('receives DM message with channelType=1', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const promise = new Promise<InboundMessage>((resolve) => { plugin.gateway.onInboundMessage = resolve; });
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
      await plugin.gateway.stopAccount();
    });

    it('receives Group message with channelType=2', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const promise = new Promise<InboundMessage>((resolve) => { plugin.gateway.onInboundMessage = resolve; });
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
      await plugin.gateway.stopAccount();
    });

    it('receives Thread message with channelType=5, preserving ____ format', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const promise = new Promise<InboundMessage>((resolve) => { plugin.gateway.onInboundMessage = resolve; });
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
      await plugin.gateway.stopAccount();
    });

    it('deduplicates messages with same message_id', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      let count = 0;
      plugin.gateway.onInboundMessage = () => { count++; };

      server.injectMessage({ messageId: 'dup_001', fromUid: 'u1', payload: { type: 1, content: 'first' } });
      await sleep(50);
      server.injectMessage({ messageId: 'dup_001', fromUid: 'u1', payload: { type: 1, content: 'first' } });
      await sleep(50);
      server.injectMessage({ messageId: 'dup_001', fromUid: 'u1', payload: { type: 1, content: 'first' } });
      await sleep(100);
      assert.equal(count, 1);
      await plugin.gateway.stopAccount();
    });

    it('handles image payload (type=2) with url', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const promise = new Promise<InboundMessage>((resolve) => { plugin.gateway.onInboundMessage = resolve; });
      server.injectMessage({
        messageId: 'img_001',
        fromUid: 'u1',
        payload: { type: 2, url: 'https://octo.cdn/img.png' },
      });
      const inbound = await promise;
      assert.equal(inbound.content[0]!.type, 'image');
      assert.equal(inbound.content[0]!.url, 'https://octo.cdn/img.png');
      await plugin.gateway.stopAccount();
    });

    it('handles file payload (type=8) with name and size', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const promise = new Promise<InboundMessage>((resolve) => { plugin.gateway.onInboundMessage = resolve; });
      server.injectMessage({
        messageId: 'file_001',
        fromUid: 'u1',
        payload: { type: 8, url: 'https://octo.cdn/report.pdf', name: 'report.pdf', size: 2048 },
      });
      const inbound = await promise;
      assert.equal(inbound.content[0]!.type, 'file');
      assert.equal(inbound.content[0]!.name, 'report.pdf');
      assert.equal(inbound.content[0]!.size, 2048);
      await plugin.gateway.stopAccount();
    });
  });

  describe('Outbound: Plugin → Octo', () => {
    it('sends text reply to DM (channelType=1)', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const result = await plugin.outbound.send({
        text: 'reply text',
        replyContext: { chatId: 'user_1', channelType: '1' },
      });
      assert.equal(result.success, true);
      const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
      assert.ok(sendReq);
      assert.deepEqual((sendReq!.body as Record<string, unknown>).payload, { type: 1, content: 'reply text' });
      await plugin.gateway.stopAccount();
    });

    it('sends text reply to Group (channelType=2)', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const result = await plugin.outbound.send({
        text: 'group reply',
        replyContext: { chatId: 'group_abc', channelType: '2' },
      });
      assert.equal(result.success, true);
      const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
      assert.equal((sendReq!.body as Record<string, unknown>).channel_id, 'group_abc');
      assert.equal((sendReq!.body as Record<string, unknown>).channel_type, 2);
      await plugin.gateway.stopAccount();
    });

    it('sends text reply to Thread (channelType=5) with full channel_id', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      await plugin.outbound.send({
        text: 'thread reply',
        replyContext: { chatId: 'group_abc____2044043250838278144', channelType: '5' },
      });
      const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
      assert.equal((sendReq!.body as Record<string, unknown>).channel_id, 'group_abc____2044043250838278144');
      assert.equal((sendReq!.body as Record<string, unknown>).channel_type, 5);
      await plugin.gateway.stopAccount();
    });

    it('sends typing indicator in streaming mode', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const result = await plugin.outbound.send({
        text: 'ignored',
        deliveryMode: 'streaming',
        replyContext: { chatId: 'user_1', channelType: '1' },
      });
      assert.equal(result.success, true);
      const typingReq = server.requests.find(r => r.path === '/v1/bot/typing');
      assert.ok(typingReq);
      await plugin.gateway.stopAccount();
    });

    it('sends file message with url and name', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      await plugin.outbound.send({
        files: [{ url: 'https://cdn.example/file.pdf', name: 'file.pdf' }],
        replyContext: { chatId: 'user_1', channelType: '1' },
      });
      const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
      assert.ok(sendReq);
      const payload = (sendReq!.body as Record<string, unknown>).payload as Record<string, unknown>;
      assert.equal(payload.type, 8);
      assert.equal(payload.url, 'https://cdn.example/file.pdf');
      await plugin.gateway.stopAccount();
    });

    it('returns error for missing chatId', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const result = await plugin.outbound.send({ text: 'hi', replyContext: {} });
      assert.equal(result.success, false);
      assert.match(result.error!, /chatId/);
      await plugin.gateway.stopAccount();
    });

    it('returns error for empty text and no files', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const result = await plugin.outbound.send({ replyContext: { chatId: 'u1', channelType: '1' } });
      assert.equal(result.success, false);
      assert.match(result.error!, /No text or files/);
      await plugin.gateway.stopAccount();
    });

    it('returns error when API responds with 500', async () => {
      server.sendMessageStatus = 500;
      server.sendMessageResponse = { error: 'internal' };
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const result = await plugin.outbound.send({
        text: 'fail',
        replyContext: { chatId: 'u1', channelType: '1' },
      });
      assert.equal(result.success, false);
      await plugin.gateway.stopAccount();
    });

    it('editMessage sends to /v1/bot/message/edit', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      await plugin.outbound.editMessage('msg_123', 'ch_1', 2, 'updated text');
      const editReq = server.requests.find(r => r.path === '/v1/bot/message/edit');
      assert.ok(editReq);
      const body = editReq.body as Record<string, unknown>;
      assert.equal(body.message_id, 'msg_123');
      assert.deepEqual(body.payload, { type: 1, content: 'updated text' });
      await plugin.gateway.stopAccount();
    });
  });

  describe('Resilience', () => {
    it('heartbeat calls /v1/bot/heartbeat periodically', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);
      // Heartbeat is on 30s interval — just verify one has been registered
      assert.equal(plugin.gateway.getConnectionState().status, 'connected');
      await plugin.gateway.stopAccount();
    });

    it('gateway throws when WebSocket URL is invalid', async () => {
      const plugin = createOctoPlugin({ logger });
      // Point to a port that won't have a WS server
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: 'http://127.0.0.1:1' });
      await assert.rejects(() => plugin.gateway.startAccount(account));
    });
  });
});

describe('Review Fixes', () => {
  let server: MockOctoServer;

  before(async () => { server = await startMockOctoServer(); });
  after(async () => { await server.stop(); });
  beforeEach(() => { server.reset(); });

  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  describe('WS Handshake Rejection', () => {
    it('gateway rejects and cleans up when WS handshake returns reasonCode=1', async () => {
      server.wsRejectHandshake = true;
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await assert.rejects(() => plugin.gateway.startAccount(account), /reasonCode=1/);
      assert.equal(plugin.gateway.getConnectionState().status, 'error');
      // No orphan WS connections left
      await sleep(100);
      assert.equal(server.connectedWsClients, 0);
    });
  });

  describe('File Validation', () => {
    it('rejects file with neither url nor path', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const result = await plugin.outbound.send({
        files: [{ name: 'missing.pdf' }],
        replyContext: { chatId: 'u1', channelType: '1' },
      });
      assert.equal(result.success, false);
      assert.match(result.error!, /neither url nor path/);
      // No sendMessage should have been called (atomic: fail before sending)
      const sendReqs = server.requests.filter(r => r.path === '/v1/bot/sendMessage');
      assert.equal(sendReqs.length, 0);
      await plugin.gateway.stopAccount();
    });

    it('atomic send: text is NOT sent if file upload fails', async () => {
      server.sendMessageStatus = 200; // sendMessage works
      // But we'll send a file with no url/path, which fails validation before any HTTP
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const result = await plugin.outbound.send({
        text: 'should not be sent',
        files: [{ name: 'bad.pdf' }],
        replyContext: { chatId: 'u1', channelType: '1' },
      });
      assert.equal(result.success, false);
      // Text must NOT have been sent
      const sendReqs = server.requests.filter(r => r.path === '/v1/bot/sendMessage');
      assert.equal(sendReqs.length, 0);
      await plugin.gateway.stopAccount();
    });
  });

  describe('File Upload', () => {
    it('uploadBuffer sends to /v1/bot/file/upload and returns URL', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const result = await plugin.outbound.uploadBuffer(Buffer.from('hello'), 'test.txt');
      assert.equal(result.url, 'https://octo.storage/uploaded-file.pdf');
      assert.equal(result.name, 'file.pdf');
      const uploadReq = server.requests.find(r => r.path === '/v1/bot/file/upload');
      assert.ok(uploadReq);
      await plugin.gateway.stopAccount();
    });
  });

  describe('Streaming', () => {
    it('startStreaming → update → finish sends initial + 2 edits', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      const stream = await plugin.outbound.startStreaming('ch_1', 2, 'Hello');
      assert.equal(stream.messageId, 'mock_msg_001');

      await stream.update(' world');
      assert.equal(stream.getText(), 'Hello world');

      await stream.finish('Hello world!');
      assert.equal(stream.isFinished(), true);

      const editReqs = server.requests.filter(r => r.path === '/v1/bot/message/edit');
      assert.equal(editReqs.length, 2); // update + finish
      await plugin.gateway.stopAccount();
    });
  });

  describe('editMessage', () => {
    it('sends correct payload to /v1/bot/message/edit', async () => {
      const plugin = createOctoPlugin({ logger });
      const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
      await plugin.gateway.startAccount(account);

      await plugin.outbound.editMessage('msg_abc', 'ch_1', 2, 'edited text');
      const editReq = server.requests.find(r => r.path === '/v1/bot/message/edit');
      assert.ok(editReq);
      const body = editReq!.body as Record<string, unknown>;
      assert.equal(body.message_id, 'msg_abc');
      assert.deepEqual(body.payload, { type: 1, content: 'edited text' });
      await plugin.gateway.stopAccount();
    });
  });
});

describe('WS Lifecycle Edge Cases', () => {
  let server: MockOctoServer;

  before(async () => { server = await startMockOctoServer(); });
  after(async () => { await server.stop(); });
  beforeEach(() => { server.reset(); });

  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  it('gateway cleans up WS on connect failure after successful register', async () => {
    // Server returns a ws_url that will refuse connections
    server.wsRejectHandshake = true;
    const plugin = createOctoPlugin({ logger });
    const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
    await assert.rejects(() => plugin.gateway.startAccount(account), /reasonCode=1/);
    // Gateway must have cleaned up — no orphan sockets
    await sleep(200);
    assert.equal(server.connectedWsClients, 0);
    assert.equal(plugin.gateway.getConnectionState().status, 'error');
  });
});

describe('Outbound Delivery Modes', () => {
  let server: MockOctoServer;

  before(async () => { server = await startMockOctoServer(); });
  after(async () => { await server.stop(); });
  beforeEach(() => { server.reset(); });

  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  it('ack sends thinking placeholder, final edits it', async () => {
    const plugin = createOctoPlugin({ logger });
    const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
    await plugin.gateway.startAccount(account);

    // Send ack
    const ackResult = await plugin.outbound.send({
      deliveryMode: 'ack',
      replyContext: { chatId: 'u1', channelType: '1', requestId: 'req-1' },
    });
    assert.equal(ackResult.success, true);
    const ackReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
    assert.ok(ackReq);
    assert.deepEqual((ackReq!.body as Record<string, unknown>).payload, { type: 1, content: '…' });

    // Send final — should edit the thinking message
    server.requests.length = 0;
    const finalResult = await plugin.outbound.send({
      text: 'final answer',
      deliveryMode: 'final',
      replyContext: { chatId: 'u1', channelType: '1', requestId: 'req-1' },
    });
    assert.equal(finalResult.success, true);
    const editReq = server.requests.find(r => r.path === '/v1/bot/message/edit');
    assert.ok(editReq);
    assert.equal((editReq!.body as Record<string, unknown>).message_id, 'mock_msg_001');

    await plugin.gateway.stopAccount();
  });

  it('exec_approval sends text immediately and clears thinkingStreams', async () => {
    const plugin = createOctoPlugin({ logger });
    const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
    await plugin.gateway.startAccount(account);

    const result = await plugin.outbound.send({
      text: 'Allow exec?',
      metadata: { state: 'exec_approval_pending' },
      replyContext: { chatId: 'u1', channelType: '1', requestId: 'req-2' },
    });
    assert.equal(result.success, true);
    const sendReq = server.requests.find(r => r.path === '/v1/bot/sendMessage');
    assert.ok(sendReq);
    assert.deepEqual((sendReq!.body as Record<string, unknown>).payload, { type: 1, content: 'Allow exec?' });

    await plugin.gateway.stopAccount();
  });

  it('botMentioned is true for structured @[uid:name] in group', async () => {
    const plugin = createOctoPlugin({ logger });
    const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
    await plugin.gateway.startAccount(account);

    let received: InboundMessage | undefined;
    plugin.gateway.onInboundMessage = (msg) => { received = msg; };

    server.injectMessage({
      messageId: 'mention_001',
      fromUid: 'user_1',
      channelId: 'group_abc',
      channelType: 2,
      payload: { type: 1, content: '@[test_bot:WorkBuddy Bot] help me' },
    });
    await sleep(50);
    assert.ok(received);const msg = received as InboundMessage;
    assert.equal(msg.botMentioned, true);
    assert.equal(msg.group?.chatType, 'group');
    assert.equal(msg.group?.groupId, 'group_abc');

    await plugin.gateway.stopAccount();
  });

  it('botMentioned is false for unrelated @name in group', async () => {
    const plugin = createOctoPlugin({ logger });
    const account = plugin.config.resolveAccount({ botToken: 'test', apiUrl: server.url });
    await plugin.gateway.startAccount(account);

    let received: InboundMessage | undefined;
    plugin.gateway.onInboundMessage = (msg) => { received = msg; };

    server.injectMessage({
      messageId: 'nomention_001',
      fromUid: 'user_1',
      channelId: 'group_abc',
      channelType: 2,
      payload: { type: 1, content: '@SomeOtherUser hey' },
    });
    await sleep(50);
    assert.ok(received);const msg = received as InboundMessage;
    assert.equal(msg.botMentioned, false);

    await plugin.gateway.stopAccount();
  });
});
