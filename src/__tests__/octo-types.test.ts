import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isThreadChannelId, parseThreadChannelId, OCTO_CHANNEL_TYPE, OCTO_MESSAGE_TYPE } from '../octo-types.js';

describe('isThreadChannelId', () => {
  it('returns true for thread channel_id', () => {
    assert.equal(isThreadChannelId('group_123____2044043250838278144'), true);
  });

  it('returns false for group channel_id', () => {
    assert.equal(isThreadChannelId('group_123'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isThreadChannelId(''), false);
  });

  it('returns false for single underscores', () => {
    assert.equal(isThreadChannelId('group_123_456'), false);
  });
});

describe('parseThreadChannelId', () => {
  it('parses thread channel_id correctly', () => {
    const result = parseThreadChannelId('group_123____2044043250838278144');
    assert.deepEqual(result, { groupNo: 'group_123', shortId: '2044043250838278144' });
  });

  it('returns null for non-thread channel_id', () => {
    assert.equal(parseThreadChannelId('group_123'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseThreadChannelId(''), null);
  });

  it('handles channel_id with multiple ____ separators', () => {
    const result = parseThreadChannelId('a____b____c');
    assert.deepEqual(result, { groupNo: 'a', shortId: 'b____c' });
  });
});

describe('constants', () => {
  it('OCTO_CHANNEL_TYPE values', () => {
    assert.equal(OCTO_CHANNEL_TYPE.DM, 1);
    assert.equal(OCTO_CHANNEL_TYPE.GROUP, 2);
    assert.equal(OCTO_CHANNEL_TYPE.THREAD, 5);
  });

  it('OCTO_MESSAGE_TYPE values', () => {
    assert.equal(OCTO_MESSAGE_TYPE.TEXT, 1);
    assert.equal(OCTO_MESSAGE_TYPE.IMAGE, 2);
    assert.equal(OCTO_MESSAGE_TYPE.FILE, 8);
  });
});
