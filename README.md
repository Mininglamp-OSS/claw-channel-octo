# claw-channel-octo

Octo IM channel plugin for WorkBuddy Claw. Same architecture as WecomAiBotPlugin — direct WebSocket + ClawPluginHost.

## Architecture

```
Octo User → WuKongIM → OctoGateway → ClawPluginHost → Agent → OctoOutbound → Octo REST API → User
```

## Install

Designed for integration into WorkBuddy desktop at `src/main/app/claw/plugins/octo/`.

## Configuration

In `~/.workbuddy/settings.json`:

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

## Development

```bash
npm install
npm run type-check
npm test
npm run build
```

## Docs

- [DESIGN.md](./DESIGN.md) — Architecture overview
- [REVIEW.md](./REVIEW.md) — Code review findings
- [OCTO-BOT-SDK-FOR-WORKBUDDY.md](./OCTO-BOT-SDK-FOR-WORKBUDDY.md) — Octo Bot API reference
