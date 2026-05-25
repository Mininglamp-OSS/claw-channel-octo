# Code Review — claw-channel-octo

## Executive Summary

The plugin follows the ClawPluginHost pattern correctly at the interface level and provides a solid foundation for Octo IM integration into WorkBuddy. However, there are several P0 issues that would prevent production integration: stale dependencies (`@modelcontextprotocol/sdk`, `zod`) that are no longer imported, the `OctoOutbound.configure()` call is never wired into the plugin lifecycle (credentials won't reach the outbound adapter), and the DESIGN.md is completely stale from a previous architecture. The core logic (gateway polling, outbound routing, config resolution) is sound but needs the lifecycle wiring fixed.

## P0 Issues (Must Fix)

### P0-1: OctoOutbound never receives credentials

**File**: `src/index.ts`, `src/octo-outbound.ts`, `src/octo-gateway.ts`  
**Problem**: `OctoOutbound.configure(apiUrl, botToken)` must be called before `send()` works, but nothing in the factory or lifecycle calls it. When ClawPluginHost calls `pluginHost.ensureStarted()` → `plugin.gateway.start(account)`, the gateway gets credentials but outbound doesn't.  
**Impact**: All replies will fail — `this.apiUrl` and `this.botToken` are empty strings.  
**Fix**: Gateway.start() should call outbound.configure(), or the factory should wire them. The most robust approach: gateway.start() receives outbound reference and configures it, or createOctoPlugin wires a shared credential holder.

### P0-2: Stale dependencies in package.json

**File**: `package.json`  
**Problem**: `@modelcontextprotocol/sdk` (^1.29.0) and `zod` (^3.23.0) are listed as dependencies but never imported anywhere in src/. Left over from the MCP Channel architecture.  
**Impact**: Bloated install, confusing for WorkBuddy team integration.  
**Fix**: Remove both from dependencies.

### P0-3: DESIGN.md is completely stale

**File**: `DESIGN.md`  
**Problem**: Still describes the Centrifugo bridge architecture (v2) which was abandoned. References auth/, centrifuge/ modules that no longer exist. Misleads anyone reading the repo.  
**Fix**: Replace with current architecture description (ClawPluginHost pattern).

### P0-4: Gateway doesn't notify plugin host of inbound messages

**File**: `src/octo-gateway.ts`  
**Problem**: Gateway emits `'inbound'` events via EventEmitter, but there's no code that subscribes to these events and calls `ClawPluginHost.emitInbound()`. In WecomAiBotPlugin, the plugin wires gateway events to the host. The current createOctoPlugin factory returns the components but doesn't wire them.  
**Impact**: Messages arrive at gateway but never reach ClawPluginHost → Agent.  
**Fix**: Add a `wirePlugin()` method or document that ClawPluginHost internally calls `plugin.gateway.on('inbound', ...)` after registration. From reverse-engineering, ClawPluginHost's `wirePlugin()` does: `plugin.gateway.on('inbound', (msg) => this.emitInbound(plugin.id, msg))`. So this may be handled by the host. Verify by checking that 'inbound' is the correct event name (WecomAiBot uses same pattern). **Keeping as P0 because if event name is wrong, nothing works.**

## P1 Issues (Should Fix)

### P1-1: No reconnection logic in polling mode

**File**: `src/octo-gateway.ts`  
**Problem**: If a poll request fails (network error, 5xx), the interval keeps firing but there's no backoff or reconnection state management. After N consecutive failures, the gateway should transition to 'error' state and attempt a full restart.  
**Fix**: Add failure counter, transition to 'error' after 10 consecutive failures, implement restart with exponential backoff.

### P1-2: No message deduplication

**File**: `src/octo-gateway.ts`  
**Problem**: If event polling returns the same event twice (race condition with ack), duplicate inbound messages will be emitted. WecomAiBot likely deduplicates by message_id.  
**Fix**: Add a Set<string> of recent message_ids (TTL 5 min) before emitting 'inbound'.

### P1-3: `any` types in Logger interface

**File**: `src/octo-config.ts`, `src/octo-gateway.ts`  
**Problem**: Logger interface uses `(...a: any[]) => void` which loses type safety.  
**Fix**: Use `(...a: unknown[]) => void` (already correct in octo-outbound.ts, inconsistent in other files).

### P1-4: No streaming reply support

**File**: `src/octo-outbound.ts`  
**Problem**: `deliveryMode === 'streaming'` only sends a typing indicator and returns success without accumulating text. WorkBuddy may call send() multiple times with streaming chunks before a final. Need to handle partial delivery or at minimum document this limitation.  
**Fix**: Add a TODO or implement basic chunked reply support.

### P1-5: bin entry in package.json is wrong

**File**: `package.json`  
**Problem**: `"bin": { "claw-channel-octo": "dist/index.js" }` — this is a library plugin, not a CLI tool. It shouldn't have a bin entry.  
**Fix**: Remove the bin field.

## P2 Issues (Nice to Have)

### P2-1: No unit tests
No test files exist. At minimum, test OctoConfigResolver.resolveAccount() and the payload parsing logic.

### P2-2: octo-types.ts exported but unused
`isThreadChannelId` and `parseThreadChannelId` are defined but never called. They're useful utilities for Phase 2 but currently dead code.

### P2-3: tsup banner adds shebang
`tsup.config.ts` adds `#!/usr/bin/env node` banner — unnecessary for a library plugin (not a CLI entrypoint).

### P2-4: No README update
README.md still references the old architecture.

## Architecture Assessment

The plugin correctly implements the ClawPluginHost factory pattern:
- ✅ `createOctoPlugin` returns `{ id, meta, config, gateway, outbound, capabilities }`
- ✅ Gateway extends EventEmitter and emits 'inbound' with correctly shaped InboundMessage
- ✅ Outbound.send() accepts OutboundMessage and returns SendResult
- ✅ Config.resolveAccount() parses raw settings into PluginAccount
- ✅ connectionMode: "websocket" in replyContext ensures plugin.outbound handles replies

The Phase 1 event polling approach is reasonable for MVP but should be clearly marked as temporary.

## Recommendations

1. Fix P0-1 immediately (credential wiring) — this is the only code-level blocker
2. Fix P0-2/P0-3 (cleanup) before sharing with WorkBuddy team
3. For Phase 2: implement WuKongIM binary WebSocket protocol for real-time delivery (polling adds 2s latency)
4. Consider adding a `clawPluginVersion` field for WorkBuddy to check compatibility
5. Add integration test that starts gateway against a mock Octo API
