# claw-channel-octo — WorkBuddy Built-in Claw Channel Plugin

> Octo IM channel for WorkBuddy, same architecture as WecomAiBotPlugin.

## Architecture

```
Octo User → WuKongIM (event polling MVP / WebSocket Phase 2)
  → OctoGateway.emit('inbound')
  → ClawPluginHost.emitInbound('octo', message)
  → ClawService → ClawRuntime → Agent processes
  → ClawPluginHost.sendOutbound('octo', response)
  → OctoOutbound.send() → Octo REST API
  → User receives reply
```

connectionMode: `"websocket"` — replies go directly via plugin.outbound, NOT through copilot.tencent.com webhook relay.

## settings.json

```json
{
  "claw": {
    "channels": {
      "octo": {
        "enabled": true,
        "botToken": "your-bot-token",
        "apiUrl": "https://im.deepminer.com.cn/api",
        "connectionMode": "websocket"
      }
    }
  }
}
```

## Integration

This plugin is designed to be integrated into WorkBuddy desktop app at `src/main/app/claw/plugins/octo/`.

Required changes in WorkBuddy:
- Add `"octo"` to `CLAW_CHANNEL_TYPES` array
- Add `"octo": "octo"` and `"octoproxy": "octo"` to `ORIGIN_TO_PLUGIN`
- Register plugin: `pluginHost.registerPlugin(createOctoPlugin)`
- Add Octo configuration card in Claw Settings UI

## Modules

| File | Purpose |
|------|---------|
| `index.ts` | Plugin factory (`createOctoPlugin`) + type definitions |
| `octo-config.ts` | Resolve account from settings.json |
| `octo-gateway.ts` | Bot registration + event polling + heartbeat |
| `octo-outbound.ts` | Send replies via Octo REST API |
| `octo-types.ts` | Channel/message type constants |

## API Reference

See [OCTO-BOT-SDK-FOR-WORKBUDDY.md](./OCTO-BOT-SDK-FOR-WORKBUDDY.md) for complete Octo Bot API documentation.
