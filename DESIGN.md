# claw-channel-octo — WorkBuddy Built-in Claw Channel Plugin

> Architecture: Direct WebSocket + ClawPluginHost (same as WecomAiBot)

## Architecture

```
                         ┌─────────────────────────────────┐
                         │   WorkBuddy Desktop             │
                         │                                 │
  Octo User @Bot         │   ClawPluginHost                │
       │                 │     ↓ emitInbound('octo', msg)  │
       ↓ Octo WebSocket     │   ClawService → ClawRuntime     │
  OctoGateway ──────────►│     ↓ Agent processes            │
  (event polling /       │   ClawPluginHost                │
   WS Phase 2)          │     ↓ sendOutbound('octo', resp) │
       ▲                 │                                 │
       │ REST API        └─────────────────────────────────┘
  OctoOutbound ◄──────────── Agent reply
       │
       ↓ sendMessage
  Octo User receives reply
```

**Two independent subsystems:**
- **OctoGateway** (常驻耳朵) — Octo WebSocket (JSON-RPC), receives messages in real-time
- **octo-cli** (Agent 的手) — AI exec calls `octo message send`, `octo group list`, etc.

connectionMode: `"websocket"` — replies go via plugin.outbound, NOT copilot.tencent.com.

## Plugin Structure

```
claw-channel-octo/
├── .workbuddy-plugin/
│   └── plugin.json              # Plugin manifest + userConfig + MCP server
├── connector/
│   ├── cli.json                 # octo-cli connector descriptor
│   └── skills/                  # Synced from octo-cli repo
│       └── README.md
├── src/                         # Plugin source (TypeScript)
│   ├── index.ts                 # createOctoPlugin factory
│   ├── octo-config.ts           # Settings → PluginAccount resolver
│   ├── octo-gateway.ts          # WebSocket + polling fallback + heartbeat
│   ├── octo-outbound.ts         # Reply via Octo REST API
│   └── octo-types.ts            # Channel/message constants
└── skills are in octo-cli repo  # Not duplicated here
```

## settings.json

```json
{
  "claw": {
    "channels": {
      "octo": {
        "enabled": true,
        "botToken": "xxx",
        "apiUrl": "https://im.deepminer.com.cn/api",
        "connectionMode": "websocket"
      }
    }
  }
}
```

## Credential Flow

1. User enables Octo plugin in WorkBuddy Claw settings
2. WorkBuddy prompts for `OCTO_BOT_TOKEN` + `OCTO_API_BASE_URL` (via plugin.json userConfig)
3. Token stored in system keychain (sensitive=true)
4. Injected into MCP server env + available to `octo` CLI commands in skills
5. OctoGateway receives credentials via `onAccountResolved` callback → starts WebSocket
6. OctoOutbound receives credentials via same callback → ready to send replies

## WorkBuddy Integration

Required changes in WorkBuddy:

```diff
 var CLAW_CHANNEL_TYPES = [
   "feishu", "wecomaibot", "qq", "dingtalk",
   "yuanbao", "weixinClawBot", "wecomIOA",
   "wechatkf", "slack", "wecomNew",
-  "custom",
+  "custom", "octo",
   "wechatmp"
 ];

 // Plugin registration
+ import { createOctoPlugin } from 'claw-channel-octo';
+ pluginHost.registerPlugin(createOctoPlugin);
```
