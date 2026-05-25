import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OctoConfigResolver } from '../octo-config.js';

const noop = (..._a: unknown[]) => {};
const logger = { info: noop, warn: noop, error: noop };

describe('OctoConfigResolver', () => {
  it('resolves a valid account', () => {
    const resolver = new OctoConfigResolver(logger);
    const account = resolver.resolveAccount({
      botToken: 'test-token-12345',
      apiUrl: 'https://example.com/api',
      connectionMode: 'websocket',
    });
    assert.equal(account.accountId, 'octo_test-tok');
    assert.equal(account.credential.botToken, 'test-token-12345');
    assert.equal(account.credential.apiUrl, 'https://example.com/api');
    assert.equal(account.platformMeta?.connectionMode, 'websocket');
  });

  it('throws on missing botToken', () => {
    const resolver = new OctoConfigResolver(logger);
    assert.throws(
      () => resolver.resolveAccount({ apiUrl: 'https://example.com/api' }),
      { message: '[OctoConfig] botToken is required' },
    );
  });

  it('defaults apiUrl when not provided', () => {
    const resolver = new OctoConfigResolver(logger);
    const account = resolver.resolveAccount({ botToken: 'abc12345' });
    assert.equal(account.credential.apiUrl, 'https://im.deepminer.com.cn/api');
  });

  it('defaults connectionMode to websocket', () => {
    const resolver = new OctoConfigResolver(logger);
    const account = resolver.resolveAccount({ botToken: 'abc12345' });
    assert.equal(account.platformMeta?.connectionMode, 'websocket');
  });

  it('accepts snake_case field names', () => {
    const resolver = new OctoConfigResolver(logger);
    const account = resolver.resolveAccount({
      bot_token: 'snake-token',
      api_url: 'https://snake.example.com/api',
      connection_mode: 'webhook',
    });
    assert.equal(account.credential.botToken, 'snake-token');
    assert.equal(account.credential.apiUrl, 'https://snake.example.com/api');
    assert.equal(account.platformMeta?.connectionMode, 'webhook');
  });
});
