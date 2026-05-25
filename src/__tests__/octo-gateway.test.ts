import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OctoGateway } from '../octo-gateway.js';

const noop = (..._a: unknown[]) => {};
const logger = { info: noop, warn: noop, error: noop };

describe('OctoGateway', () => {
  it('initializes with disconnected state', () => {
    const gw = new OctoGateway(logger);
    assert.deepEqual(gw.getConnectionState(), { status: 'disconnected' });
  });

  it('calls onAccountResolved callback on start', async () => {
    let resolved = false;
    const gw = new OctoGateway(logger, () => { resolved = true; });
    // start() will fail because there's no real API, but callback should fire first
    try {
      await gw.start({
        accountId: 'test',
        credential: { botToken: 'fake', apiUrl: 'http://localhost:1' },
      });
    } catch {
      // Expected — no real server
    }
    assert.equal(resolved, true);
  });

  it('sets state to error on start failure', async () => {
    const gw = new OctoGateway(logger);
    try {
      await gw.start({
        accountId: 'test',
        credential: { botToken: 'fake', apiUrl: 'http://localhost:1' },
      });
      assert.fail('start() should have thrown');
    } catch {
      // Expected
    }
    const state = gw.getConnectionState();
    assert.equal(state.status, 'error');
  });

  it('stop() sets state to disconnected', async () => {
    const gw = new OctoGateway(logger);
    await gw.stop();
    assert.deepEqual(gw.getConnectionState(), { status: 'disconnected' });
  });
});
