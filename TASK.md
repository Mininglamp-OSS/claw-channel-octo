# Task: Complete Phase 2 Features + README Cleanup

## Overview
Complete unfinished/partially-implemented roadmap items in claw-channel-octo and clean up documentation.

## Work Items

### 1. WebSocket Real-time Connection (replaces HTTP polling)

**Current state**: Gateway uses HTTP event polling every 2s. Code has TODO for WS.

**Protocol**: WuKongIM uses **JSON-RPC over WebSocket** (NOT binary). Reference: `easyjssdk` npm package.

**Implementation plan**:
- Add a `OctoWebSocket` class in new file `src/octo-websocket.ts`
- Flow:
  1. `POST /v1/bot/register` → get `ws_url` + `im_token` (already done in gateway)
  2. Connect WebSocket to `ws_url`
  3. Send JSON-RPC `connect` request: `{ method: "connect", params: { uid: bot_uid, token: im_token, deviceId: "claw_<random>", deviceFlag: 2 }, id: "<uuid>" }`
  4. Receive JSON-RPC response with `result: { serverKey, salt, timeDiff, reasonCode }`
  5. Start ping keepalive (send JSON-RPC `{ method: "ping", params: {}, id: "<uuid>" }` every 25s)
  6. Receive messages as JSON-RPC notifications: `{ method: "recv", params: { header, messageId, messageSeq, timestamp, channelId, channelType, fromUid, payload } }`
     - payload is **base64-encoded JSON string** — decode with `Buffer.from(payload, 'base64').toString('utf-8')` then `JSON.parse()`
  7. Acknowledge with notification: `{ method: "recvack", params: { header, messageId, messageSeq } }`
- Modify `OctoGateway`:
  - After register, try WebSocket connection first
  - If WS fails, fall back to HTTP polling (keep existing polling code as fallback)
  - Replace heartbeat with WS ping/pong
  - Keep existing dedup logic
- Use `ws` package (already in devDependencies) for Node.js WebSocket
- Keep HTTP heartbeat as well (Bot online status needs REST heartbeat)

### 2. File Upload

**Current state**: Outbound can send files by URL, but no upload implementation.

**API**: `POST {apiUrl}/v1/bot/file/upload` with multipart/form-data. Returns `{ url, name, size }`.

**Implementation plan**:
- Add `uploadFile(filePath: string): Promise<{ url: string; name: string; size: number }>` to `OctoOutbound`
- In `send()`, if `message.files` have local paths (not URLs), upload first to get URLs
- Add `uploadBuffer(buffer: Buffer, filename: string): Promise<...>` variant
- Use `undici` for multipart upload (already a dependency)

### 3. Streaming Replies (message edit pattern)

**Current state**: `deliveryMode === 'streaming'` only sends typing indicator.

**API**: `POST {apiUrl}/v1/bot/message/edit` with `{ message_id, channel_id, channel_type, payload }`.

**Implementation plan**:
- Add `editMessage(messageId: string, channelId: string, channelType: number, payload: Record<string, unknown>): Promise<void>` to `OctoOutbound`
- Streaming flow:
  1. First chunk: `sendMessage()` → returns message_id (need to capture this)
  2. Subsequent chunks: `editMessage(message_id, ...)` with accumulated text
  3. Final: `editMessage(message_id, ...)` with complete text
- Modify `send()` to return message_id in SendResult
- Add `streamingEdit(messageId: string, text: string, replyContext: ...): Promise<void>` method

### 4. README Cleanup

- Replace ALL "WuKongIM" references with "Octo" (4+ occurrences)
- Update roadmap checkboxes to reflect actual state after implementation
- Keep internal code comments mentioning protocol details (they're implementation detail, not user-facing)

### 5. Fix plugin.json Skills Path

**Current state**: plugin.json declares 4 skill paths under `connector/skills/` that don't exist.

**Fix**: Update plugin.json to remove the non-existent skill paths OR add a note that skills are provided by octo-cli installation (not bundled). The cleanest fix: remove `skills` array from plugin.json since skills live in octo-cli repo, and document this in connector/skills/README.md.

### 6. Update Tests

- Add tests for OctoWebSocket class
- Add tests for file upload
- Add tests for message edit/streaming
- Update existing tests if interfaces change

## Constraints

- TypeScript strict mode
- ESM modules (type: "module" in package.json)
- Use `undici` for HTTP (already dependency)
- Use `ws` for WebSocket (already devDependency — move to dependencies)
- All existing tests must pass
- Run `npm run type-check && npm test && npm run build` before committing

## File Structure After Changes

```
src/
├── index.ts              # Update exports
├── octo-config.ts        # No changes
├── octo-gateway.ts       # Major: add WS mode, fallback to polling
├── octo-websocket.ts     # NEW: WebSocket connection manager
├── octo-outbound.ts      # Add uploadFile, editMessage, streaming support
├── octo-types.ts         # Add new type constants if needed
└── __tests__/
    ├── octo-gateway.test.ts      # Update for WS mode
    ├── octo-websocket.test.ts    # NEW
    ├── octo-outbound.test.ts     # Update for upload/edit
    └── ...
```
