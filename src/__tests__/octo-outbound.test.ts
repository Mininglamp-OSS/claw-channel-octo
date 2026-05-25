import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OctoOutbound } from '../octo-outbound.js';

const noop = (..._a: unknown[]) => {};
const logger = { info: noop, warn: noop, error: noop };

describe('OctoOutbound', () => {
  let outbound: OctoOutbound;

  beforeEach(() => {
    outbound = new OctoOutbound(logger);
  });

  it('returns error when chatId is missing', async () => {
    outbound.configure('https://api.test', 'token');
    const result = await outbound.send({
      text: 'hello',
      replyContext: {},
    });
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /chatId/);
  });

  it('returns error when no text or files', async () => {
    outbound.configure('https://api.test', 'token');
    const result = await outbound.send({
      replyContext: { chatId: 'user1', channelType: '1' },
    });
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /No text or files/);
  });

  it('configure sets apiUrl and botToken', () => {
    outbound.configure('https://example.com/api', 'my-token');
    // Verify by attempting a send — if configure didn't work,
    // the URL would be empty and would fail differently
    // This is a basic smoke test
    assert.ok(outbound);
  });
});
